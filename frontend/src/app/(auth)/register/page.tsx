"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const next = searchParams.get("next");
    const target = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
    router.replace(target);
  }, [router, searchParams]);

  return null;
}
