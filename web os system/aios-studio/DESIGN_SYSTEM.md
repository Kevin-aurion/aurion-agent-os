# LazyOffice AIOS Design System

## Design goal

Make enterprise Agent configuration feel calm and progressive while keeping
governance states explicit. Public Cherry Studio interaction patterns informed
the navigation and configuration density; all components, styles, wording and
data bindings here are original LazyOffice work.

## Foundations

- Canvas: near-black `#080B12`; configuration surfaces rise in three layers.
- Accent: indigo `#7C83FF` for selection and primary action, never for success.
- Semantics: green = active/passed; amber = waiting/FDE/Sandbox; red = rejected,
  failed or blocked; blue = informational.
- Radius: 10px controls, 14px cards, 20px workspaces.
- Typography: system sans with Taiwanese Traditional Chinese fallback.
- Focus: every interactive element has a visible three-pixel focus ring.
- Motion: short 150–220ms transitions; disabled under reduced-motion settings.

## Interaction model

1. Persistent left navigation separates workspace, resource and governance.
2. Agent is the main configuration object.
3. Six Agent tabs expose Overview, Models, Tool/MCP, Knowledge, Skill and
   Deployment without placing all fields on one screen.
4. Common settings remain visible; advanced policies use disclosures.
5. Status chips preserve precise backend states instead of masking them.
6. Every production-affecting area repeats the required FDE or evaluation gate.

## Components

- `AppShell`: navigation, environment, connection and user context.
- `PageHeader`: purpose and one primary action.
- `Section`: bounded group of related settings.
- `SettingRow`: explanation on the left, control or state on the right.
- `Disclosure`: progressive advanced configuration.
- `Badge` / `StatusBadge`: shared governance vocabulary.
- `GateNotice`: explains a hard boundary before the user reaches the control.
- `EmptyState`: truthful absence with next-step guidance.
- `Metric`: small operational summary without becoming a monitoring dashboard.

## Next iterations

- Command palette behind the visible search affordance.
- Side-by-side version diff for Skill and Agent configuration.
- Runtime trace tree for model, MCP and Knowledge spans.
- Inline Change Proposal review from each setting.
- FDE-only credential reference editor and MCP health action.
- Knowledge source upload/ingestion journey with classification preview.
