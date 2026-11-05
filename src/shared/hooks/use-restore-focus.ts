"use client";

import { useCallback, useRef } from "react";

/**
 * Focus-return for Radix dialogs that are opened programmatically (e.g. from a store)
 * rather than via `Dialog.Trigger`.
 *
 * Radix's modal content always prevents its default close-autofocus and focuses the
 * `Dialog.Trigger` element, which doesn't exist for controlled/store-driven dialogs —
 * leaving focus on `<body>` after close. This hook remembers whatever was focused when
 * the dialog opened and restores it on close.
 */
export function useRestoreFocus() {
  const returnTo = useRef<HTMLElement | null>(null);

  // Fired before Radix moves focus into the dialog, so `activeElement` is still the opener.
  const onOpenAutoFocus = useCallback(() => {
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement ? active : null;
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();

    const target = returnTo.current;
    returnTo.current = null;

    if (target && target.isConnected) {
      target.focus({ preventScroll: true });
    }
  }, []);

  return { onOpenAutoFocus, onCloseAutoFocus };
}
