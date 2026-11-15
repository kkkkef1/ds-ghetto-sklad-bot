// ===================== ОЧЕРЕДЬ НА ДОСТУП К САЙТУ =====================
//
// Склад и твинки заходят на gta5rp.com одним аккаунтом и одним профилем браузера
// (куки общие, чтобы не вводить код Google Authenticator дважды). Два браузера на одном
// профиле работать не могут, поэтому доступ к сайту строго по очереди: что уже работает —
// доделывается до конца, второе ждёт и стартует сразу после него.

let tail: Promise<void> = Promise.resolve();
let holder: string | null = null;
const waiting: string[] = [];

export function withSiteLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  waiting.push(label);
  const run = tail.then(async () => {
    waiting.splice(waiting.indexOf(label), 1);
    holder = label;
    try {
      return await fn();
    } finally {
      holder = null;
    }
  });
  // Очередь не должна ломаться из-за ошибки предыдущего задания.
  tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Кто сейчас на сайте и кто ждёт. */
export function siteLockInfo(): { holder: string | null; waiting: string[] } {
  return { holder, waiting: [...waiting] };
}
