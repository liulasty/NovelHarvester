import { apiJson } from './api.js';

// Fallback only (e.g. when server not reachable during static preview).
export const DEFAULT_SCRAPERS = ['book18', 'shuwen6', 'diyibanzhu', 'nzxs', 'bookszw', '69xku', '9ksw', 'kateman'];

export async function fetchScrapers() {
  const data = await apiJson('/api/scrapers');
  if (data && Array.isArray(data.scrapers) && data.scrapers.length > 0) return data.scrapers;
  return DEFAULT_SCRAPERS;
}
