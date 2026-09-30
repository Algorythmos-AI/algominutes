// The few chrome.* APIs this extension uses, typed here rather than pulling in @types/chrome.
// Shapes from https://developer.chrome.com/docs/extensions/reference/api.
declare namespace chrome {
  namespace runtime {
    const id: string;
    interface MessageSender {
      id?: string;
      url?: string;
      origin?: string;
    }
    const onMessageExternal: {
      addListener(
        cb: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void,
      ): void;
    };
  }
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    // In memory only, cleared when the browser closes, and not readable by content scripts.
    const session: StorageArea;
  }
  namespace tabs {
    function create(props: { url: string }): Promise<unknown>;
  }
}
