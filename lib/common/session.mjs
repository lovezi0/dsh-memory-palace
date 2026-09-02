// memory-palace v1.6.2-alpha.4 DSH 0.1.2-alpha.4 兼容层：Session.events getter 已被删除
// （宿主 27bf1039「distinguish event seqs from log offsets」顺带移除），替代 API 为
// snapshotEvents(from, toExclusive)——半开区间、from 含、返回冻结数组；运行时 seq 仍是
// 普通 number，wire/磁盘格式不变。旧版宿主（≤0.1.2-alpha.3）无此方法，回退 events + filter。
// 统一出口：调用方零分支，语义 =「取 seq >= fromSeq 的事件（升序）」。
export function eventsFrom(session, fromSeq = 0) {
  if (typeof session?.snapshotEvents === "function") {
    return session.snapshotEvents(fromSeq);
  }
  return (session?.events || []).filter((e) => e.seq >= fromSeq);
}
