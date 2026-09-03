import type { Env } from "./index";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * General web search, used as a tool the model can call mid-answer (see
 * `chat.ts`) for anything time-sensitive or outside its training data —
 * news, current events, sports scores, prices, anything that could have
 * changed. Backed by the Brave Search API (api.search.brave.com); optional —
 * absent `BRAVE_SEARCH_API_KEY`, the tool isn't offered to the model at all
 * (see `chat.ts`), so ROSE degrades to answering from what it already knows,
 * same as before this existed.
 */
export async function webSearch(env: Env, query: string, count = 5): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": env.BRAVE_SEARCH_API_KEY ?? "",
    },
  });

  if (!res.ok) {
    throw new Error(`web search request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    web?: { results?: { title: string; url: string; description: string }[] };
  };

  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    // Brave's snippets can carry <strong> highlight tags — strip them, this
    // is going straight into a model prompt as plain text.
    snippet: r.description.replace(/<\/?[^>]+>/g, ""),
  }));
}
