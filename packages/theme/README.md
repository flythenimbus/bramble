# @vault/theme

The single source of truth for Bramble's design tokens: the color scale,
radius scale, dark-mode variant, and the Tailwind v4 `@theme inline` mapping
that turns those CSS variables into utilities (`bg-background`, `text-muted-foreground`, ...).

Every surface imports it so the extension, the mobile app, and the marketing
website stay pixel-identical:

```css
@import "tailwindcss";
@import "@vault/theme/theme.css"; /* must come after tailwindcss */
```

Change a color here and it changes everywhere. There is deliberately no build
step: it is plain CSS that each consumer's `@tailwindcss/vite` pipeline inlines.
