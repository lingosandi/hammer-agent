/**
 * hammer-agent — browser-safe entry point.
 *
 * Exports everything needed to build a tool-calling bash-format chat agent.
 * No Node.js built-ins. Safe for browser, React, Next.js app-router SSR, etc.
 *
 * Node.js-only utilities (TiktokenEstimator, file I/O helpers) are in
 * the separate "hammer-agent/node" export.
 */

// ── Config ──────────────────────────────────────────────────────────────────
export {
    configure,
    getProviderConfig,
    type HammerAgentConfig,
    type HammerAgentProviderPreset,
} from "./configure"

// ── Zod schemas ───────────────────────────────────────────────────────────────
export {
    ToolCallSchema,
    LLMResponseSchema,
} from "./schemas"

// ── Core types ───────────────────────────────────────────────────────────────
export type {
    ChatMessage,
    FetchResponseLike,
    FetchLike,
    LLMProviderConfig,
    LLMRequestOptions,
    StreamCallbacks,
    LLMClientResponse,
    ToolDataPrimitive,
    ToolDataValue,
    ToolDataSchema,
    ToolParameterDefinition,
    ToolMemoryNoteScope,
    ToolMemoryNoteKind,
    ToolMemoryEvidenceKind,
    ToolMemoryCitationKind,
    ToolMemoryNotePolicy,
    ToolMemoryEvidencePolicy,
    ToolMemoryMetadata,
    ToolDefinitionMetadata,
    ToolDefinition,
    ToolCall,
    ToolResult,
    LoopOutcome,
    LLMRequest,
    LLMResponse,
    ProviderName,
} from "./types"

// ── LLM client ───────────────────────────────────────────────────────────────
export { LLMClient, ApiError } from "./llm-client"

// ── Agent loop ───────────────────────────────────────────────────────────────
export {
    AgentLoop,
    type ConversationAdapter,
    type AgentLoopCallbacks,
    type AgentLoopDeps,
    type ParsedStepInput,
    type ToolExecutionResult,
    type StepResult,
} from "./agent-loop"

export {
    agentMachine,
    AGENT_MACHINE_STATES,
    type AgentMachineState,
    type TruncatedToolInfo,
    type AgentMachineContext,
    type AgentMachineEvent,
} from "./agent-machine"

// ── Base runtimes ─────────────────────────────────────────────────────────────
export {
    ToolLoopAgentRuntime,
    type ToolLoopRuntimeStepContext,
    type ToolLoopRuntimeRunStepOptions,
    type ToolLoopRuntimeLLMRequest,
    type ToolLoopRuntimeLLMResponse,
    type ToolLoopRuntimeHooks,
    type ToolLoopAgentRuntimeDeps,
    type ToolLoopRuntimeSetup,
    type ToolLoopRuntimeInfrastructure,
    type ToolLoopRuntimeRunStepResult,
    type ToolLoopRuntimeExecuteStepResult,
} from "./tool-loop-agent-runtime"

export {
    WebToolLoopAgentRuntime,
    suppressWebValidationLog,
    readDiagnosticLevel,
    readDiagnosticSource,
    mapConversationRoleToAgentRole,
    type WebToolLoopRuntimeStateLike,
    type CreateWebRuntimeSetupOptions,
    type ExecuteWebLoopRunOptions,
    type WebToolLoopAgentRuntimeConstructorOptions,
} from "./web-tool-loop-agent-runtime"

// ── Validation ────────────────────────────────────────────────────────────────
export {
    BaseValidationEnforcer,
    createConversationSink,
    type ConversationSink,
    type EnforcerResult,
} from "./validation-enforcer"

export { WebValidationEnforcer } from "./web-validation-enforcer"

// ── Memory layer ──────────────────────────────────────────────────────────────
export {
    BaseMemoryLayer,
    CharTokenEstimator,
    type MemoryMessage,
    type TokenEstimator,
    type CompactionLLMClient,
    type MemoryProvenance,
    type PersistedMemoryData,
    type CompactionCursor,
    type MemoryStorage,
} from "./memory-layer"

export {
    AgentMemoryLayer,
    DEFAULT_TOOL_MEMORY_EXTRACTOR,
    type AgentMemoryLayerConfig,
    type ToolMemoryExtractor,
    type AgentMemoryLogger,
    type RawMessage,
    type AgentMemoryNote,
    type AgentMemoryCitation,
    type AgentMemoryEvidence,
    type AgentMemoryConstraint,
    type AgentMemoryTask,
} from "./agent-memory-layer"

export {
    createAgentMemoryLayer,
    type AgentMemoryFactoryOverrides,
} from "./agent-memory-factory"

// ── Prompt building ───────────────────────────────────────────────────────────
export {
    buildAgentSystemPrompt,
    buildAgentIdentityLine,
    buildCoreStaticRules,
    buildWebRuntimeRules,
    buildSkillsSection,
    buildSkillAwareStaticContext,
    buildWorkspaceCodingStaticRules,
    buildStepUserMessage,
    shouldSkipStepUserMessage,
    extractTruncatedToolInfo,
    formatToolsSection,
    DEFAULT_AGENT_FALLBACK_SYSTEM_PROMPT,
    CODE_QUALITY_RULE_LINE,
    INCREMENTAL_TESTING_RULE_LINE,
    PORT_CONFLICT_RULE_LINE,
    TODO_LIST_FIRST_RESPONSE_RULE_LINE,
    SKILL_INVOKE_READ_RULE_LINE,
    VALIDATE_AFTER_CHANGES_RULE_LINE,
    ROOT_CAUSES_RULE_LINE,
    ERROR_RECOVERY_RULE_LINE,
    createAppendToolsSectionCustomizer,
    createToolsSectionOverrideCustomizer,
    type SkillSummaryLike,
    type SystemPromptCustomizer,
    type SystemPromptSections,
    type SystemPromptBuildContext,
    type WorkspaceCodingStaticRulesOptions,
} from "./prompt-helpers"

// ── Response parsing + recovery ───────────────────────────────────────────────
export {
    parseAgentResponse,
    type ParsedAgentResponse,
    type ParseAgentResponseOptions,
} from "./agent-response-parser"

export {
    parseResponseWithRecovery,
    buildParseFeedback,
    formatZodValidationError,
    buildValidationErrorMessage,
    buildNoStructuredResponseFoundError,
    ERROR_TRUNCATED_RESPONSE,
} from "./tool-call-recovery"

// ── Tool execution + bash injection ───────────────────────────────────────────
export {
    RunCommand,
    RunCommandRegistry,
    ToolRunCommand,
    BashRunCommand,
    BackgroundBashRunCommand,
    createCustomRunCommandRegistry,
    createRunCommandRuntimeBindings,
    createBackgroundBashDefinition,
    executeToolCallWithRunCommands,
    getRunCommandPromptAvailability,
    DEFAULT_RUN_COMMAND_REGISTRY,
    DEFAULT_ALLOWED_RUN_TARGETS,
    SUPPORTED_RUN_TARGETS,
    type RunInvocationTarget,
    type RunCommandParseResult,
    type RunCommandPromptAvailability,
    type BackgroundBashAction,
    type ParsedBackgroundBashCommand,
} from "./run-command-registry"

export {
    isBashToolCall,
    isBackgroundBashToolCall,
    resolveToolDefinitionForInvocation,
    formatUnixToolSurface,
    formatToolCallAsUnixCommand,
    parseUnixToolCommand,
    tokenizeUnixCommand,
    executeUnixCommandString,
    executeBackgroundUnixCommandString,
    extractPrimaryCommandMetadata,
    enrichToolResultWithUnixMetadata,
    type CommandRuntime,
    type CommandTargetInfo,
} from "./unix-tooling"

export { truncateToolResult, executeToolSafe, formatToolResultMessage, parseToolResultMessage, MAX_TOOL_RESULT_CHARS } from "./tool-helpers"

// ── Streaming parser ──────────────────────────────────────────────────────────
export { StreamingToolParser, type StreamingToolParserCallbacks } from "./streaming-tool-parser"

// ── Runtime store (web / React) ───────────────────────────────────────────────
export {
    createRuntimeStore,
    defineRuntimeController,
    type RuntimeSubscriber,
    type RuntimeSnapshotUpdater,
    type RuntimeStore,
    type RuntimeController,
} from "./runtime-store"

// ── Web agent types ───────────────────────────────────────────────────────────
export {
    createInitialWebAgentState,
    machineStateToWebAgentPhase,
    createWebAgentMessageIdGenerator,
    type AgentPhase,
    type AgentMessage,
    type AgentState,
} from "./web-agent-types"

export {
    PendingAgentMessageBuffer,
    createToolAgentMessage,
    createWebToolLoopCallbacks,
    applyIdleWebAgentState,
    applyInitialWebAgentRunState,
} from "./web-runtime-tooling"

// ── Thread / UI helpers ───────────────────────────────────────────────────────
export {
    shouldAutoScrollThread,
    getToolLogSummaryLine,
    stripDiagnosticMessagePrefix,
    getDiagnosticSummaryLine,
    buildToolLogRevealFrames,
    DEFAULT_THREAD_AUTO_SCROLL_BOTTOM_THRESHOLD,
} from "./agent-thread"

export { createWebSearchToolActions, type WebSearchToolActionInput } from "./web-search-tool-actions"

// ── Tool infrastructure (base class + registry + proxy adapter) ───────────────
export {
    Tool,
    type ToolLike,
    type ToolSchema,
    type ToolMetadata,
} from "./Tool"

export {
    ToolRegistry,
    createToolRegistry,
    type ToolRegistryOptions,
    type ToolRegistryMissingToolContext,
    type ToolRegistryBeforeExecuteContext,
} from "./registry"

export { ProxyTool, type ProxyToolExecutor } from "./ProxyTool"

// ── Command response utilities ────────────────────────────────────────────────
export {
    formatToolDefinitions,
    parseStructuredAgentText,
    coerceToolCallToDefinition,
    containsStandaloneStructuredInvocationStart,
} from "./command-response-utils"

export {
    executeToolLoopStep,
    type ToolLoopStepExecutorOptions,
    type ToolLoopStepExecutionResult,
    type ToolLoopStepExecutorResponse,
    type ToolLoopStepExecutorCallbacks,
} from "./tool-loop-step-executor"

// ── Misc utilities ─────────────────────────────────────────────────────────────
export { decodeEscapedShellText } from "./shell-escape-normalization"
export { buildToolUsageExample } from "./tool-usage-examples"
export { type TodoItem, type TodoStatus } from "./todo-types"
export { type BuildMemoryCompactionPromptOptions } from "./memory-compaction-prompts"
export {
    buildCompactionEntry,
    canonicalizeCompactionText,
    runStructuredLLMCompaction,
    selectLatestByKey,
    limitEntriesByRecency,
} from "./memory-compaction-utils"

export {
    TOOL_CALL_SEPARATOR_RULE,
    STANDARD_TOOL_CALL_FORMAT_RULES,
    JUST_BASH_SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES,
    JUST_BASH_SCRIPT_EXECUTION_RESTRICTION_LINES,
    SHARED_TOOL_CALL_EXAMPLE_LINES,
    SINGLE_TOOL_CALL_RUN_LINE_EXAMPLE,
    SHARED_TOOL_USAGE_RULE,
} from "./tool-call-prompts"
