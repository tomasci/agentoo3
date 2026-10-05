// Project Automations: a per-project schedule that fires a prompt into a
// brand-new session on a cron, with pause/resume and a run history. Mirrors
// the Idea Manager's own barrel shape (`features/ideas/index.ts`): pages sit
// alongside their hooks, since a route adapter (`app/project-routes.tsx`) is
// the only caller outside this directory and it needs the page components,
// not the pieces that build them.

export { AutomationDetailPage } from './components/automation-detail-page'
export { AutomationsListPage } from './components/automations-list-page'
export {
  type Automation,
  type AutomationRun,
  useAutomation,
  useAutomationRuns,
  useAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  usePreviewSchedule,
  useUpdateAutomation,
} from './hooks/use-automations'
export { formatInZone } from './lib/format'
export {
  cronFromFields,
  type DayOfWeek,
  DEFAULT_SCHEDULE_FIELDS,
  describeSchedule,
  EVERY_N_HOURS_OPTIONS,
  fieldsFromCron,
  fieldsFromPreset,
  fromCron,
  presetFromFields,
  type ScheduleFieldsValue,
  type ScheduleKind,
  type SchedulePreset,
  toCron,
} from './lib/schedule'
export { AUTOMATION_TONE, RUN_STATUS_TONE, SESSION_STATUS_TONE } from './lib/status'
export { type AutomationFormValues, automationFormSchema } from './model/automation-form.schema'
