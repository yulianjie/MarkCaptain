<script setup lang="ts">
import { agentM1Copy, agentWritingCommandLabel, AGENT_WRITING_COMMANDS, type AgentWritingCommand } from '@/services/agent-m1-copy'
const props = defineProps<{ locale: string; disabled?: boolean }>()
const emit = defineEmits<{ choose: [command: AgentWritingCommand] }>()
const label = (key: Parameters<typeof agentM1Copy>[1]) => agentM1Copy(props.locale, key)
const commandLabel = (command: AgentWritingCommand) => agentWritingCommandLabel(command, props.locale)
</script>

<template>
  <details class="agent-writing-commands">
    <summary>{{ label('commandMenu') }}</summary>
    <div class="agent-writing-command-list">
      <button v-for="command in AGENT_WRITING_COMMANDS" :key="command" type="button" :disabled="disabled" @click="emit('choose', command)">{{ commandLabel(command) }}</button>
    </div>
  </details>
</template>
