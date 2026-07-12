import '@testing-library/jest-dom';

class ResizeObserverMock {
  disconnect = () => undefined;

  observe = () => undefined;

  unobserve = () => undefined;
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

vi.stubGlobal(
  'fetch',
  vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected network request in test: ${String(input)}`);
  }),
);
