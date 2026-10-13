# Component previews

Run `npm run storybook`, then open `http://127.0.0.1:6006` in your preferred browser. The command does not open a browser automatically.

Select a component and state from the sidebar. Use **Controls** to change its props and the viewport toolbar to select a 280px, 360px, or 480px sidebar. Approval buttons, model selection, draft editing, attachment removal, and question answers use local sample state. Callbacks appear in **Actions**; saving does not contact DSH or change extension settings.

Stories load the real webview CSS and Basecoat scripts. The preview stylesheet allows scrolling outside the VS Code webview. Stories and sample data live here; stateful wrappers are in `previews/`.

To add a preview, create a `Component.stories.svelte` file with `defineMeta` and named `Story` states. Follow a neighboring story. Use a wrapper when callbacks or bindings need to update local state, and copy fixture data so one preview cannot change another.

Run `npm run check:storybook` to check the stories and `npm run build-storybook` to build a static preview into `storybook-static/`.
