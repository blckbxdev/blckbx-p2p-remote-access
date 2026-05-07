export function deferred<T>() {
  let resolver!: (value: T) => void;
  let rejecter!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });

  return { promise, resolve: resolver, reject: rejecter };
}
