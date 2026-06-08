import { registerBundledSkill } from '../bundledSkills.js'

const SEARCH_STRATEGIES = `# Knowledge MCP Search Strategies

Query patterns for gathering organizational context during plugin customization.

## Finding Tool Names

**Source control:**
- Search: "GitHub" OR "GitLab" OR "Bitbucket"
- Search: "pull request" OR "merge request"
- Look for: repository links, CI/CD mentions

**Project management:**
- Search: "Asana" OR "Jira" OR "Linear" OR "Monday"
- Search: "sprint" AND "tickets"
- Look for: task links, project board mentions

**Chat:**
- Search: "Slack" OR "Teams" OR "Discord"
- Look for: channel mentions, integration discussions

**Analytics:**
- Search: "Datadog" OR "Grafana" OR "Mixpanel"
- Search: "monitoring" OR "observability"
- Look for: dashboard links, alert configurations

**Design:**
- Search: "Figma" OR "Sketch" OR "Adobe XD"
- Look for: design file links, handoff discussions

**CRM:**
- Search: "Salesforce" OR "HubSpot"
- Look for: deal mentions, customer record links

## Finding Organization Values

**Workspace/project IDs:**
- Search for existing integrations or bookmarked links
- Look for admin/setup documentation

**Team conventions:**
- Search: "story points" OR "estimation"
- Search: "workflow" OR "ticket status"
- Look for engineering process docs

**Channel/team names:**
- Search: "standup" OR "engineering" OR "releases"
- Look for channel naming patterns

## When Knowledge MCPs Are Unavailable

If no knowledge MCPs are configured, skip automatic discovery and proceed directly to AskUserQuestion for all categories. Note: AskUserQuestion always includes a Skip button and a free-text input box for custom answers, so do not include \`None\` or \`Other\` as options.
`

const MCP_SERVERS = `# MCP Discovery and Connection

How to find and connect MCPs during plugin customization.

## Available Tools

### \`search_mcp_registry\`
Search the MCP directory for available connectors.

**Input:** \`{ "keywords": ["array", "of", "search", "terms"] }\`

**Output:** Up to 10 results, each with:
- \`name\`: MCP display name
- \`description\`: One-liner description
- \`tools\`: List of tool names the MCP provides
- \`url\`: MCP endpoint URL (use this in \`.mcp.json\`)
- \`directoryUuid\`: UUID for use with suggest_connectors
- \`connected\`: Boolean - whether user has this MCP connected

### \`suggest_connectors\`
Display Connect buttons to let users install/connect MCPs.

**Input:** \`{ "directoryUuids": ["uuid1", "uuid2"] }\`

**Output:** Renders UI with Connect buttons for each MCP

## Category-to-Keywords Mapping

| Category | Search Keywords |
|----------|-----------------|
| \`project-management\` | \`["asana", "jira", "linear", "monday", "tasks"]\` |
| \`software-coding\` | \`["github", "gitlab", "bitbucket", "code"]\` |
| \`chat\` | \`["slack", "teams", "discord"]\` |
| \`documents\` | \`["google docs", "notion", "confluence"]\` |
| \`calendar\` | \`["google calendar", "calendar"]\` |
| \`email\` | \`["gmail", "outlook", "email"]\` |
| \`design-graphics\` | \`["figma", "sketch", "design"]\` |
| \`analytics-bi\` | \`["datadog", "grafana", "analytics"]\` |
| \`crm\` | \`["salesforce", "hubspot", "crm"]\` |
| \`wiki-knowledge-base\` | \`["notion", "confluence", "outline", "wiki"]\` |
| \`data-warehouse\` | \`["bigquery", "snowflake", "redshift"]\` |
| \`conversation-intelligence\` | \`["gong", "chorus", "call recording"]\` |

## Workflow

1. **Find customization point**: Look for \`~~\`-prefixed values (e.g., \`~~Jira\`)
2. **Check earlier phase findings**: Did you already learn which tool they use?
   - **Yes**: Search for that specific tool to get its \`url\`, skip to step 5
   - **No**: Continue to step 3
3. **Search**: Call \`search_mcp_registry\` with mapped keywords
4. **Present choices and ask user**: Show all results, ask which they use
5. **Connect if needed**: If not connected, call \`suggest_connectors\`
6. **Update MCP config**: Add config using the \`url\` from search results

## Updating Plugin MCP Configuration

### Finding the Config File

1. **Check \`plugin.json\`** for an \`mcpServers\` field. If present, edit the file at that path.
2. **If no \`mcpServers\` field**, use \`.mcp.json\` at the plugin root (default).
3. **If \`mcpServers\` points only to \`.mcpb\` files** (bundled servers), create a new \`.mcp.json\` at the plugin root.

### Directory Entries Without a URL

Some directory entries have no \`url\` because the endpoint is dynamic. These servers can still be referenced in the plugin's MCP config by **name**: if the MCP server name in the config matches the directory entry name, it is treated the same as a URL match.
`

const COMPONENT_SCHEMAS = `# Component Schemas

Plugin components use the same schema as Claude Code's plugin system, but Cowork users usually find skills most useful.

## Components

| Component | Location | Format |
|-----------|----------|--------|
| Skills | \`skills/*/SKILL.md\` | Markdown + YAML frontmatter |
| MCP Servers | \`.mcp.json\` | JSON |
| Agents | \`agents/*.md\` | Markdown + YAML frontmatter |
| Hooks | \`hooks/hooks.json\` | JSON |
| Commands (legacy) | \`commands/*.md\` | Markdown + YAML frontmatter |

## Skills

Scaffold new plugins with \`skills/*/SKILL.md\`. Skill bodies are instructions for Claude to follow, not documentation for the user to read. Use progressive disclosure: lean SKILL.md content with detailed material in \`references/\`.

## CONNECTORS.md

Create CONNECTORS.md only when a plugin intentionally references external tools by category rather than specific products. Use \`~~category\` placeholders and explain which real tools can satisfy each category.
`

const EXAMPLE_PLUGINS = `# Example Plugins

Use these structures as templates when implementing plugins.

## Minimal Plugin: Single Skill

A simple plugin contains \`.claude-plugin/plugin.json\`, one \`skills/<skill-name>/SKILL.md\`, and README.md.

## Standard Plugin: Skills + MCP

Use this when the plugin combines workflow instructions with an external service connector. Include \`.mcp.json\` and document required environment variables in README.md.

## Full-Featured Plugin

Use skills, agents, hooks, and MCP only when each component has a clear job. Start small: one well-crafted skill is more useful than five half-baked components.
`

const COWORK_PLUGIN_PROMPT = `# Cowork Plugin Authoring

Create a new Cowork plugin from scratch, or customize an existing one for a specific organization. Both paths deliver a ready-to-install \`.plugin\` file at the end.

## Determining the Mode

Decide from the user's request:

- **Customize** — the user names an existing installed plugin ("customize the X plugin", "configure X for my company", "set up the X plugin", "update the X skill"). Follow **Customizing an Existing Plugin** below.
- **Create** — the user wants to build a plugin from scratch ("create a plugin for X", "make a new plugin", "build a plugin that does X"). Follow **Creating a New Plugin** below.

> **Nontechnical output**: Keep all user-facing conversation in plain language. Never mention file paths, directory structures, schema fields, \`~~\` prefixes, or placeholders unless the user asks. Frame everything in terms of what the plugin will do.

> **AskUserQuestion**: When you need input, use AskUserQuestion. Don't assume "industry standard" defaults are correct. AskUserQuestion always includes a Skip button and a free-text input box for custom answers, so do not include \`None\` or \`Other\` as options.

## Plugin Architecture

A plugin is a self-contained directory that extends Claude with skills, agents, hooks, and MCP server integrations.

### Directory Structure

\`\`\`
plugin-name/
├── .claude-plugin/
│   └── plugin.json           # Required: plugin manifest
├── skills/                   # Skills (subdirectories with SKILL.md)
│   └── skill-name/
│       ├── SKILL.md
│       └── references/
├── agents/                   # Subagent definitions (.md files)
├── .mcp.json                 # MCP server definitions
└── README.md                 # Plugin documentation
\`\`\`

> **Legacy \`commands/\` format**: Older plugins may include a \`commands/\` directory with single-file \`.md\` slash commands. This format still works, but new plugins should use \`skills/*/SKILL.md\` instead — the Cowork UI presents both as a single "Skills" concept, and the skills format supports progressive disclosure via \`references/\`.

**Rules:**
- \`.claude-plugin/plugin.json\` is always required
- Component directories go at the plugin root, not inside \`.claude-plugin/\`
- Only create directories for components the plugin actually uses
- Use kebab-case for all directory and file names
- Use \`\${CLAUDE_PLUGIN_ROOT}\` for intra-plugin path references; never hardcode absolute paths

## Creating a New Plugin

Build from scratch through a five-phase guided conversation.

### Phase 1: Discovery
Understand what the user wants to build and why. Ask only what is unclear.

### Phase 2: Component Planning
Determine which component types are needed. Cowork users will usually find skills the most useful. Scaffold new plugins with \`skills/*/SKILL.md\`; do not create \`commands/\` unless the user explicitly needs the legacy single-file format.

### Phase 3: Design & Clarifying Questions
Specify each component in detail. If the user says "whatever you think is best," provide specific recommendations and get explicit confirmation.

### Phase 4: Implementation
Create the plugin directory structure, manifest, components, and README. Skills use progressive disclosure: lean SKILL.md body, detailed content in \`references/\`. Skill descriptions must include specific trigger phrases.

### Phase 5: Review
Run \`claude plugin validate <path-to-plugin-json>\` when available. If unavailable, verify manually: manifest exists and is valid JSON, name is kebab-case, referenced component directories exist, and every skill directory contains SKILL.md.

## Customizing an Existing Plugin

Customize a plugin for a specific organization — either by setting up a generic plugin template for the first time, or by tweaking an already-configured plugin.

### Finding the plugin
Run \`find mnt/.local-plugins mnt/.plugins ~/.claude/plugins/synced -type d -name "*<plugin-name>*" 2>/dev/null\` to locate the plugin directory, then read its files to understand its structure before making changes.

If you cannot find the plugin directory in any of those locations, let the user know: "I couldn't find an installed plugin named '<plugin-name>'. If it's installed on your desktop, open this task from the Cowork desktop app so I can access it."

### Determining the Customization Mode
After locating the plugin, check for \`~~\`-prefixed placeholders.

1. **Generic plugin setup** — The plugin contains \`~~\`-prefixed placeholders. Replace customization points with real values.
2. **Scoped customization** — No \`~~\` placeholders exist, and the user asked to customize a specific part. Focus only on that section.
3. **General customization** — No \`~~\` placeholders exist, and the user wants broad changes. Read the plugin files, then ask what they'd like to change.

> **Important**: Never change the name of the plugin or skill being customized. Do not rename directories, files, or the plugin/skill name fields.

### Customization Workflow

#### Phase 0: Gather User Intent
If the user provided context, use it and skip questions already answered. Otherwise ask one short, specific open-ended question with AskUserQuestion.

#### Phase 1: Gather Context from Knowledge MCPs
Use company-internal knowledge MCPs to collect relevant tool names, organizational processes, team conventions, and configuration values. See \`references/search-strategies.md\`.

#### Phase 2: Create Todo List
Build a todo list of scoped changes. Use user-friendly descriptions that focus on what the plugin will do, not file paths.

#### Phase 3: Complete Todo Items
Apply clear answers directly from user input or knowledge MCP findings. Otherwise use AskUserQuestion.

#### Phase 4: Search for Useful MCPs
After customization items are resolved, connect MCPs for identified tools. See \`references/mcp-servers.md\`. Collect MCP results and present them together in the summary output.

## Packaging

After create or customize completes, package the plugin as a \`.plugin\` file and deliver it with SendUserFile.

1. Zip the plugin directory, excluding setup artifacts and OS metadata.
2. Call SendUserFile with the \`.plugin\` file and a short caption summarizing what was built or changed.

> **Naming**: Use the plugin name from \`plugin.json\` for create, or the original plugin directory name for customize. Do not rename the plugin or its files during customization.

## Best Practices

- **Start small**: A plugin with one well-crafted skill is more useful than one with five half-baked components.
- **Progressive disclosure for skills**: Core knowledge in SKILL.md, details in \`references/\`, examples in \`examples/\`.
- **Clear trigger phrases**: Skill descriptions should include specific phrases users would say.
- **Skills are for Claude**: Write skill bodies as instructions for Claude to follow.
- **Imperative writing style**: Use verb-first instructions.
- **Portability**: Always use \`\${CLAUDE_PLUGIN_ROOT}\` for intra-plugin paths.
- **Security**: Use environment variables for credentials, HTTPS for remote servers, least-privilege tool access.

## Additional Resources

- **\`references/component-schemas.md\`** — Detailed format specifications for every component type
- **\`references/example-plugins.md\`** — Complete example plugin structures
- **\`references/mcp-servers.md\`** — MCP discovery workflow and config file format
- **\`references/search-strategies.md\`** — Knowledge MCP query patterns for finding tool names and org values
`

const COWORK_PLUGIN_DESCRIPTION =
  'Create a new Cowork plugin from scratch, or customize an installed plugin for a specific organization. Use when: customize plugin, set up plugin, configure plugin, tailor plugin, adjust plugin settings, customize plugin connectors, customize plugin skill, tweak plugin, modify plugin configuration, create a plugin, build a plugin, make a new plugin, develop a plugin, scaffold a plugin.'

export function registerCoworkPluginSkill(): void {
  registerBundledSkill({
    name: 'cowork-plugin',
    description: COWORK_PLUGIN_DESCRIPTION,
    userInvocable: false,
    isEnabled: () => process.env.CLAUDE_CODE_ENTRYPOINT === 'remote_cowork',
    files: {
      'references/component-schemas.md': COMPONENT_SCHEMAS,
      'references/example-plugins.md': EXAMPLE_PLUGINS,
      'references/mcp-servers.md': MCP_SERVERS,
      'references/search-strategies.md': SEARCH_STRATEGIES,
    },
    async getPromptForCommand(args) {
      const sections = [COWORK_PLUGIN_PROMPT.trimStart()]
      const request = args?.trim()
      if (request) {
        sections.push(`## User Request\n${request}`)
      }
      return [{ type: 'text', text: sections.join('\n') }]
    },
  })
}
