/**
 * Output contracts for our own jobs, passed via `--json-schema`.
 *
 * Verified at runtime by the capability probe: this build populates
 * `structured_output` on the result, so these are enforced by the CLI rather
 * than scraped out of prose.
 */

export const CHANGE_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'goal', 'brief', 'cards', 'attention'],
  properties: {
    title: { type: 'string', description: 'Short name for what this change accomplishes' },
    goal: { type: 'string', description: 'The outcome being accepted, in one sentence' },
    brief: {
      type: 'object',
      additionalProperties: false,
      required: ['whatChanged', 'whyThisApproach', 'assessment', 'evidenceAndCaveats'],
      properties: {
        whatChanged: {
          type: 'string',
          description: 'Two or three short sentences on practical before/after behaviour, grouped by purpose not filename',
        },
        whyThisApproach: {
          type: 'string',
          description: 'The most consequential choice, one credible alternative, the tradeoff. Say so plainly if there was no real design choice.',
        },
        assessment: {
          type: 'object',
          additionalProperties: false,
          required: ['scope', 'codebase', 'maintenance'],
          properties: {
            scope: { $ref: '#/$defs/verdict' },
            codebase: { $ref: '#/$defs/verdict' },
            maintenance: { $ref: '#/$defs/verdict' },
          },
        },
        evidenceAndCaveats: {
          type: 'string',
          description: 'What validation actually demonstrates, and the most important remaining uncertainty',
        },
      },
    },
    cards: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'scope', 'state', 'risk', 'files'],
        properties: {
          id: { type: 'string', description: 'kebab-case stable id' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'The consequence, not a file list' },
          scope: { type: 'string', enum: ['Requested', 'Supporting', 'Extra'] },
          state: { type: 'string', enum: ['Planned', 'Changed', 'Verified', 'Blocked'] },
          risk: { type: 'string', enum: ['high', 'medium', 'low'] },
          why: { type: 'string' },
          alternative: { type: 'string' },
          tradeoff: { type: 'string' },
          files: {
            type: 'array',
            description: 'Repo-relative paths belonging to this card. Every reviewable file must appear in exactly one card.',
            items: { type: 'string' },
          },
        },
      },
    },
    attention: {
      type: 'array',
      maxItems: 3,
      description: 'At most three material caveats or decisions the reviewer must make',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'text'],
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'critical'] },
          text: { type: 'string' },
        },
      },
    },
  },
  $defs: {
    verdict: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'reason'],
      properties: {
        verdict: { type: 'string', enum: ['Good', 'Mixed', 'Concern', 'Unknown'] },
        reason: { type: 'string', description: 'A concrete reason or a named evidence gap — never generic praise' },
      },
    },
  },
} as const;

export const NARRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrations'],
  properties: {
    narrations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['unitAlias', 'what', 'significance', 'score'],
        properties: {
          unitAlias: { type: 'string', description: 'The H### alias of the change being explained' },
          what: { type: 'string', description: 'What this change does, in plain language. One or two sentences.' },
          significance: {
            type: 'string',
            enum: ['major', 'minor', 'routine'],
            description:
              'major: changes behaviour a reviewer must accept deliberately. minor: worth a glance. ' +
              'routine: renames, imports, formatting, mechanical test updates. Most changes in a diff are routine.',
          },
          score: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description:
              'Overall quality, 1 (poor) to 5 (exemplary). 3 is ordinary competent code. ' +
              'Anything below 3 must be justified by an axis entry.',
          },
          axes: {
            type: 'array',
            maxItems: 3,
            description:
              'Only axes you have something real to say about. Omit an axis rather than rating it ' +
              '"ok" to look thorough — a list of three bland ratings on every change is noise.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['axis', 'rating', 'reason'],
              properties: {
                axis: {
                  type: 'string',
                  enum: ['conventions', 'clarity', 'design'],
                  description:
                    'conventions: the documented house rules. clarity: readable, well named, idiomatic. ' +
                    'design: right abstraction, survives change, fixes the cause rather than the symptom.',
                },
                rating: { type: 'string', enum: ['strong', 'ok', 'weak'] },
                reason: { type: 'string', description: 'One sentence, concrete. Never generic praise.' },
                rule: {
                  type: 'string',
                  description:
                    'conventions only: the rule being broken, quoted from the conventions file. ' +
                    'If you cannot quote it, you do not have a conventions finding.',
                },
                source: {
                  type: 'string',
                  description: 'conventions only: the repo-relative path of the file that rule came from',
                },
              },
            },
          },
          why: { type: 'string', description: 'What it is in service of, when that is not obvious' },
          watchFor: {
            type: 'string',
            description:
              'What a reviewer should scrutinise here. Omit entirely unless it would change what they do.',
          },
        },
      },
    },
  },
} as const;
