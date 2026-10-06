import { NextResponse, type NextRequest } from "next/server";
import { createSupabase } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabase();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
