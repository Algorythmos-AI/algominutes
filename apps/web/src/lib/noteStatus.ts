import { setDoc, type DocumentReference } from 'firebase/firestore';

export async function markNoteError(noteRef: DocumentReference, errorMessage: string): Promise<void> {
  await setDoc(
    noteRef,
    {
      status: 'error',
      errorMessage,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
}
