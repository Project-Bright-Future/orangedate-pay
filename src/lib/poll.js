const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 通用輪詢：每 intervalMs 打一次 fetchFn，isDone(res) 為 true 即回該筆；
// 達 maxAttempts 仍未完成 → 回最後一筆 + timedOut:true。單次 fetch 失敗不中斷。
export async function pollUntil(fetchFn, isDone, { intervalMs = 2000, maxAttempts = 15 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      last = await fetchFn();
      if (isDone(last)) return last;
    } catch (_) {}
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  return { ...last, timedOut: true };
}
