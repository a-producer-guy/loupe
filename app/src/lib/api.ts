import "server-only";
import type { z } from "zod";
import { LutError } from "@/lib/footage/luts";
import { DropError } from "@/lib/footage/register";

// Small helpers so every API route answers the same way: plain-English errors,
// and nothing technical leaks to the browser.

export function jsonError(status: number, error: string, code?: string): Response {
  return Response.json({ error, code }, { status });
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "The request wasn't readable.");
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : jsonError(400, "The request had something missing or wrong in it.");
}

export function route<C>(handler: (request: Request, ctx: C) => Promise<Response>) {
  return async (request: Request, ctx: C): Promise<Response> => {
    try {
      return await handler(request, ctx);
    } catch (error) {
      if (error instanceof DropError || error instanceof LutError) return jsonError(400, error.message);
      console.error(error);
      return jsonError(500, "Something went wrong on our side. Try again in a moment.");
    }
  };
}

export async function shootIdFrom(params: Promise<{ id: string }>): Promise<number | null> {
  const id = Number((await params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
