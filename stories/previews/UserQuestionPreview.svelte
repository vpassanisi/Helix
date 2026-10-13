<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import { untrack } from 'svelte'
  import UserQuestionCard from '../../src/webview/components/UserQuestionCard.svelte'
  let { args }: { args: ComponentProps<typeof UserQuestionCard> } = $props()
  let value = $state(untrack(() => structuredClone($state.snapshot(args.value))))
  $effect(() => { value = structuredClone($state.snapshot(args.value)) })
</script>

<UserQuestionCard {value} onanswer={(answer) => { args.onanswer(answer); value = { ...value, status: 'answered', answer } }} />
