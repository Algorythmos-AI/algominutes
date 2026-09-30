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
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    function getContexts(filter: { contextTypes: string[] }): Promise<unknown[]>;
    const onMessage: {
      addListener(
        cb: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void,
      ): void;
    };
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
    const onChanged: { addListener(cb: (changes: Record<string, unknown>, area: string) => void): void };
  }
  namespace tabs {
    function create(props: { url: string }): Promise<unknown>;
    // Without the "tabs" permission a tab's id is given, but not its url or title.
    function query(q: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number }>>;
  }
  namespace tabCapture {
    // Allowed once the user has invoked the extension on that tab (its toolbar button).
    function getMediaStreamId(options: { targetTabId: number }): Promise<string>;
  }
  namespace offscreen {
    function createDocument(params: { url: string; reasons: string[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
  }
  namespace action {
    function setBadgeText(details: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  }
}
