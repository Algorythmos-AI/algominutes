// Reading the body of a failed response, for its error message. An unreadable
// or non-JSON body is not a second error to surface (the status already failed
// the call), but it is logged rather than swallowed (CLAUDE.md: no silent catches).

/** The response text, or '' when the body can't be read. */
export async function readErrorText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch (err) {
    console.warn('response_body_unreadable', { status: resp.status, err });
    return '';
  }
}

/** The parsed JSON body, or {} when it isn't JSON. Typed `any`, like `resp.json()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readErrorJson(resp: Response): Promise<any> {
  try {
    return await resp.json();
  } catch (err) {
    console.warn('response_body_not_json', { status: resp.status, err });
    return {};
  }
}
