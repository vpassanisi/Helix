import { defineRegistry } from '@json-render/svelte'
import { helixGenUiCatalog } from '../../../shared/gen-ui-catalog.js'
import Alert from './components/Alert.svelte'
import Badge from './components/Badge.svelte'
import Button from './components/Button.svelte'
import Card from './components/Card.svelte'
import Checkbox from './components/Checkbox.svelte'
import CodeBlock from './components/CodeBlock.svelte'
import Grid from './components/Grid.svelte'
import Heading from './components/Heading.svelte'
import List from './components/List.svelte'
import ListItem from './components/ListItem.svelte'
import Metric from './components/Metric.svelte'
import Progress from './components/Progress.svelte'
import SelectInput from './components/SelectInput.svelte'
import Separator from './components/Separator.svelte'
import Stack from './components/Stack.svelte'
import Table from './components/Table.svelte'
import Text from './components/Text.svelte'
import TextInput from './components/TextInput.svelte'

/**
 * The catalog, given a body. Every component type the model may name is here,
 * drawn with the Basecoat and VS Code tokens the rest of the sidebar uses, so a
 * card is a piece of Helix rather than a screenshot of somebody's dashboard.
 *
 * The catalog is the whole surface: a type that is not in this map does not
 * render, which is what makes an agent-authored spec safe to mount.
 */
export const { registry } = defineRegistry(helixGenUiCatalog, {
  components: {
    Stack,
    Grid,
    Card,
    Heading,
    Text,
    Separator,
    Badge,
    Alert,
    Table,
    Metric,
    Progress,
    CodeBlock,
    List,
    ListItem,
    Button,
    TextInput,
    SelectInput,
    Checkbox,
  },
})
