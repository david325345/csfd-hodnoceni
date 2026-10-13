/**
 * Jednoduchá fronta: nejvýš `concurrency` úloh najednou a mezi starty
 * jednotlivých úloh alespoň `delayMs`. Slouží k šetrnému volání ČSFD.
 */
export function createLimiter({ concurrency = 2, delayMs = 500 } = {}) {
  const queue = [];
  let running = 0;
  let lastStart = 0;
  let timer = null;

  const pump = () => {
    if (timer) return;
    while (running < concurrency && queue.length) {
      const wait = lastStart + delayMs - Date.now();
      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          pump();
        }, wait);
        return;
      }
      const { fn, resolve, reject } = queue.shift();
      running++;
      lastStart = Date.now();
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        pump();
      });
    },
    get pending() {
      return queue.length;
    },
    get running() {
      return running;
    }
  };
}
