// 一次"回合"(turn)的服务端所有权。
//
// 改造前:生成的生命周期挂在那条 SSE 连接上 —— res 一 close 就 ac.abort()。
// 于是手机锁屏、切后台、刷新页面、地铁里断一下网,正在生成的回答就没了,已经
// 烧掉的额度也白烧。这不是"边缘情况":移动端上它就是常态。
//
// 改造后(借鉴 cc-haha 的做法:会话由服务端持有,客户端只是订阅者):
//   · 回合由本模块持有,SSE 连接只是【订阅者】,来去自由;
//   · 最后一个订阅者离开后进入宽限期(chatDisconnectGraceMs),期间生成继续;
//     宽限期到了还没人回来才真的取消 —— "没人看"和"不要了"是两件事;
//   · 只有显式的 /stop 才等于"不要了",立刻取消上游;
//   · 每个事件带序号 n,重连时带 from=n 续传;序号太旧就先发一份快照。
//
// 回合结束时的落盘由 runner 自己在 finally 里做,与有没有订阅者无关 —— 这是
// "关掉页面再回来,回答还在"的唯一保证。

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
// 结束后再留一会儿:客户端可能正好在这几秒里重连回来拿尾巴
const KEEP_DONE_MS = 60 * 1000;
// 细粒度续传的事件窗口。超出这个跨度的重连拿快照(内容一样,只是少了打字机效果)
const EVENT_WINDOW = 4000;

export function createRunRegistry({ graceMs = DEFAULT_GRACE_MS, maxPerPrincipal = 3, log = () => {} } = {}) {
  const runs = new Map(); // key(principal/sessionId) -> run

  function countFor(principal) {
    let n = 0;
    for (const r of runs.values()) if (r.principal === principal && !r.done) n++;
    return n;
  }

  function drop(run) {
    if (runs.get(run.key) === run) runs.delete(run.key);
    if (run.graceTimer) clearTimeout(run.graceTimer);
    if (run.keepTimer) clearTimeout(run.keepTimer);
    run.graceTimer = null;
    run.keepTimer = null;
  }

  // 事件进日志 + 广播。订阅者的异常绝不能把生成打断(一个坏 sink 不该让所有人
  // 一起丢内容),所以逐个 try。
  function emitTo(run, ev) {
    ev.n = ++run.seq;
    run.events.push(ev);
    if (run.events.length > EVENT_WINDOW) run.events.splice(0, run.events.length - EVENT_WINDOW);
    for (const sink of [...run.subscribers]) {
      try {
        sink.send(ev);
      } catch {
        run.subscribers.delete(sink);
      }
    }
  }

  // 宽限期:没人看着了,但活还在干。到点还没人回来才取消。
  function armGrace(run) {
    if (run.done || run.subscribers.size) return;
    if (run.graceTimer) clearTimeout(run.graceTimer);
    if (graceMs <= 0) {
      // 显式配 0 = 保持旧语义(断开即取消)
      log(`[chat] 回合 ${run.id} 无人订阅且未配宽限期,立即取消`);
      run.abortedBy = 'disconnect';
      run.ac.abort();
      return;
    }
    run.graceTimer = setTimeout(() => {
      run.graceTimer = null;
      if (run.done || run.subscribers.size) return;
      log(`[chat] 回合 ${run.id} 宽限 ${Math.round(graceMs / 1000)}s 内无人重连,取消上游`);
      run.abortedBy = 'disconnect';
      run.ac.abort();
    }, graceMs);
    // 宽限期计时器不该把进程钉在事件循环里(否则 Ctrl+C 之后还要等 5 分钟)
    if (run.graceTimer.unref) run.graceTimer.unref();
  }

  function start({ key, principal, sessionId, model, deviceName, runner }) {
    const existing = runs.get(key);
    if (existing && !existing.done) {
      return { ok: false, busy: true, run: existing };
    }
    if (existing) drop(existing);
    if (countFor(principal) >= maxPerPrincipal) {
      return { ok: false, error: `同时进行的对话不能超过 ${maxPerPrincipal} 个,请等一个说完` };
    }

    const run = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      key,
      principal,
      sessionId,
      model,
      deviceName,
      startedAt: Date.now(),
      endedAt: 0,
      seq: 0,
      events: [],
      subscribers: new Set(),
      done: false,
      text: '',
      thinking: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      error: null,
      stopped: false,
      abortedBy: null,
      ac: new AbortController(),
      graceTimer: null,
      keepTimer: null,
    };
    runs.set(key, run);

    const api = {
      emit: (ev) => emitTo(run, ev),
      signal: run.ac.signal,
      // runner 边收边把累计值写回来,快照才有东西可发
      setText: (t) => {
        run.text = t;
      },
      setThinking: (t) => {
        run.thinking = t;
      },
      setUsage: (u) => {
        run.usage = { ...run.usage, ...u };
      },
      // 客户端主动断开导致的取消,和显式 /stop 要能区分开:前者不该在
      // 消息上留"已停止"的标记(用户并没有点停止,只是网断了)
      stoppedByUser: () => run.abortedBy === 'stop',
      abortedByDisconnect: () => run.abortedBy === 'disconnect',
    };

    // runner 是个 async 函数;它自己负责落盘。这里只管收尾与广播。
    Promise.resolve()
      .then(() => runner(api))
      .catch((err) => {
        run.error = run.error || err.message;
        try {
          emitTo(run, { t: 'error', message: '生成失败: ' + err.message });
        } catch {
          /* 没有订阅者也无所谓,错误已经落在 run 上 */
        }
      })
      .finally(() => {
        run.done = true;
        run.endedAt = Date.now();
        if (run.graceTimer) clearTimeout(run.graceTimer);
        run.graceTimer = null;
        for (const sink of [...run.subscribers]) {
          try {
            sink.end();
          } catch {
            /* ignore */
          }
        }
        run.subscribers.clear();
        // 留一小会儿:正在重连的客户端还能把尾巴取回去
        run.keepTimer = setTimeout(() => drop(run), KEEP_DONE_MS);
        if (run.keepTimer.unref) run.keepTimer.unref();
      });

    return { ok: true, run };
  }

  // 订阅。from = 客户端已经收到的最后一个序号(0 = 什么都没有)。
  // 手上的事件窗口覆盖不到 from 时先补一份快照,再接着往下发 —— 内容不会缺,
  // 只是那一段没有逐字动画。
  function subscribe(key, from, sink) {
    const run = runs.get(key);
    if (!run) return { ok: false, error: '这个回合已经结束了' };

    const oldest = run.events.length ? run.events[0].n : run.seq + 1;
    if (from > 0 && from >= oldest - 1) {
      for (const ev of run.events) if (ev.n > from) sink.send(ev);
    } else {
      sink.send({
        n: run.seq,
        t: 'snapshot',
        runId: run.id,
        sessionId: run.sessionId,
        model: run.model,
        text: run.text,
        thinking: run.thinking,
        usage: run.usage,
        startedAt: run.startedAt,
      });
    }

    if (run.done) {
      // 已经结束:补发结束事件后直接收尾,不挂订阅
      sink.send({ n: run.seq + 1, t: 'done', sessionId: run.sessionId, stopped: run.stopped, replayed: true });
      sink.end();
      return { ok: true, run, live: false };
    }

    run.subscribers.add(sink);
    if (run.graceTimer) {
      clearTimeout(run.graceTimer);
      run.graceTimer = null;
      log(`[chat] 回合 ${run.id} 有客户端重连,宽限期取消`);
    }
    return {
      ok: true,
      run,
      live: true,
      unsubscribe: () => {
        run.subscribers.delete(sink);
        armGrace(run);
      },
    };
  }

  // 显式停止:这才是"不要了"
  function stop(key) {
    const run = runs.get(key);
    if (!run || run.done) return { ok: false, error: '没有正在进行的回合' };
    run.stopped = true;
    run.abortedBy = 'stop';
    run.ac.abort();
    return { ok: true, runId: run.id };
  }

  // 某个会话现在有没有活着的回合(前端进页面时据此决定要不要接回去)
  function live(key) {
    const run = runs.get(key);
    if (!run || run.done) return null;
    return {
      runId: run.id,
      seq: run.seq,
      model: run.model,
      startedAt: run.startedAt,
      chars: run.text.length,
      watchers: run.subscribers.size,
    };
  }

  function liveFor(principal) {
    const out = [];
    for (const run of runs.values()) {
      if (run.principal !== principal || run.done) continue;
      out.push({ sessionId: run.sessionId, runId: run.id, seq: run.seq, startedAt: run.startedAt, model: run.model });
    }
    return out;
  }

  // 进程退出前把所有还在跑的回合掐掉,免得 fetch 把关闭吊住
  function shutdown() {
    for (const run of [...runs.values()]) {
      if (!run.done) {
        run.abortedBy = 'shutdown';
        run.ac.abort();
      }
      drop(run);
    }
  }

  return { start, subscribe, stop, live, liveFor, shutdown, graceMs, count: () => runs.size };
}
