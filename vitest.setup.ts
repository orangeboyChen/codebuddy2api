import '@testing-library/jest-dom';

class ResizeObserverMock {
  disconnect = () => undefined;

  observe = () => undefined;

  unobserve = () => undefined;
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);
