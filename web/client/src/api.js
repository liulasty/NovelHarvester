export async function apiJson(url, options = {}) {
  const { parseJson = true, ...rest } = options;
  const headers = { ...rest.headers };
  if (rest.body != null && typeof rest.body === 'object' && !(rest.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    rest.body = JSON.stringify(rest.body);
  }
  const res = await fetch(url, { ...rest, headers });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text && parseJson) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const msg = (data && data.error) || text || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function tasksUrl() {
  return '/api/tasks';
}
