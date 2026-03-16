/**
 * Loads a prompt from a publicly accessible URL (e.g. Yandex Object Storage).
 *
 * Usage:
 *   const prompt = await loadPrompt(
 *     "https://storage.yandexcloud.net/<bucket>/<key>.txt"
 *   );
 */
export async function loadPrompt(url: string): Promise<string> {
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `Failed to load prompt from ${url}: ${res.status} ${res.statusText}`,
    );
  }

  return res.text();
}
