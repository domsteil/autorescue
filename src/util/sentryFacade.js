let cached = null;

export async function loadSentry() {
  if (cached) return cached;
  try {
    cached = await import('@sentry/node');
  } catch (error) {
    console.warn(
      'Sentry SDK unavailable; falling back to no-op implementation:',
      error.message,
    );
    cached = createNoopSentry();
  }
  return cached;
}

function createNoopSentry() {
  const noop = () => {};
  return {
    init: noop,
    addBreadcrumb: noop,
    captureException: noop,
    startTransaction() {
      return {
        setStatus: noop,
        finish: noop,
      };
    },
  };
}
