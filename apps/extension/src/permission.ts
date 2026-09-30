// An extension page, opened in a tab, only to ask for the microphone: the offscreen document that records
// can't show Chrome's prompt itself (ADR 0002 §1). Once allowed, the extension's origin keeps the permission.
const show = (id: 'ask' | 'allowed' | 'refused') => {
  for (const x of ['ask', 'allowed', 'refused']) document.getElementById(x)!.hidden = x !== id;
};
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (stream) => {
    for (const t of stream.getTracks()) t.stop();
    show('allowed');
  },
  () => show('refused'),
);
