"use client";

import { Search } from "lucide-react";

export function SearchInput() {
  return (
    <div className="relative w-[320px]">
      <Search
        size={16}
        className="absolute left-3 top-1/2 -translate-y-1/2 text-white/60"
      />

      <input
        type="text"
        placeholder="Search..."
        onFocus={() => {
          const event = new KeyboardEvent("keydown", {
            key: "k",
            metaKey: true,
          });

          document.dispatchEvent(event);
        }}
        className="
          w-full
          rounded-md
          bg-white/10
          pl-9
          pr-3
          py-2
          text-sm
          text-white
          placeholder:text-white/50
          outline-none
          ring-1
          ring-white/10
          focus:ring-white/20
          transition
        "
      />
    </div>
  );
}
