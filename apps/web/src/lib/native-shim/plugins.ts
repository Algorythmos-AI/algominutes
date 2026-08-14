// Web shims for the Capacitor plugins the not-yet-generalised web App.tsx still
// imports on its native branches. Capture/import via native plugins does not run
// on the web client (mobile records, web reads). The enum VALUES are provided
// because the ported code references them; the plugin OBJECTS throw if a native
// path is actually hit on web. TODO(web A8): delete these when App.tsx's native
// branches are removed and the web app is generalised.

function nativeOnly(name: string): any {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error(`${name} is native-only; not available on the web client.`);
        };
      },
    },
  );
}

// @capacitor/camera
export const Camera = nativeOnly('Camera');
export enum CameraResultType {
  Uri = 'uri',
  Base64 = 'base64',
  DataUrl = 'dataUrl',
}
export enum CameraSource {
  Prompt = 'PROMPT',
  Camera = 'CAMERA',
  Photos = 'PHOTOS',
}

// @capacitor/filesystem
export const Filesystem = nativeOnly('Filesystem');
export enum Directory {
  Documents = 'DOCUMENTS',
  Data = 'DATA',
  Library = 'LIBRARY',
  Cache = 'CACHE',
  External = 'EXTERNAL',
  ExternalStorage = 'EXTERNAL_STORAGE',
}

// @capacitor/share
export const Share = nativeOnly('Share');

// @capacitor-firebase/authentication
export const FirebaseAuthentication = nativeOnly('FirebaseAuthentication');
