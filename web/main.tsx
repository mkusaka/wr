import { createInertiaApp, type ResolvedComponent } from "@inertiajs/react";
import { NuqsAdapter } from "nuqs/adapters/react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });

createInertiaApp({
  resolve: async (name) => {
    const pages = import.meta.glob<{ default: ResolvedComponent }>("./pages/**/*.tsx");
    return (await pages[`./pages/${name}.tsx`]!()).default;
  },
  setup({ el, App, props }) {
    createRoot(el).render(
      <NuqsAdapter>
        <App {...props} />
      </NuqsAdapter>,
    );
  },
});
