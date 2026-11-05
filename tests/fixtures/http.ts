import { request } from "node:http";

// Use raw HTTP when testing Host headers; fetch derives Host from its URL.
export function requestWithHost(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: init.method || "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            headers.append(
              response.rawHeaders[i]!,
              response.rawHeaders[i + 1]!,
            );
          resolve(
            new Response(Buffer.concat(chunks).toString(), {
              status: response.statusCode,
              headers,
            }),
          );
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.setTimeout(5000, () =>
      outgoing.destroy(new Error("HTTP test request timed out")),
    );
    outgoing.end(init.body);
  });
}
