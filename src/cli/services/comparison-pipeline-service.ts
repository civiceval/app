import { getConfig } from '../config';
import { ComparisonConfig, EvaluationMethod, PromptResponseData, EvaluationInput, FinalComparisonOutputV2, Evaluator, IDEAL_MODEL_ID, ConversationMessage } from '../types/comparison_v2';
import { getModelResponse, DEFAULT_TEMPERATURE } from './llm-service';
import { checkForErrors } from '../utils/response-utils';
import { EmbeddingEvaluator } from '@/cli/evaluators/embedding-evaluator';
import { LLMCoverageEvaluator } from '@/cli/evaluators/llm-coverage-evaluator';
import { saveResult as saveResultToStorage } from '@/lib/storageService';
import { toSafeTimestamp } from '@/lib/timestampUtils';

type Logger = ReturnType<typeof getConfig>['logger'];

async function generateAllResponses(
    config: ComparisonConfig,
    logger: Logger,
    useCache: boolean
): Promise<Map<string, PromptResponseData>> {
    logger.info(`[PipelineService] Generating model responses... Caching: ${useCache}`);
    const pLimit = (await import('p-limit')).default;
    const limit = pLimit(config.concurrency || 10);
    const allResponsesMap = new Map<string, PromptResponseData>();
    const tasks: Promise<void>[] = [];
    let generatedCount = 0;

    const temperaturesToRun: (number | undefined)[] = 
        (config.temperatures && config.temperatures.length > 0) 
            ? config.temperatures 
            : [config.temperature]; // Use single global temp or undefined if not set

    const systemPromptsToRun: (string | null | undefined)[] =
        (config.systems && config.systems.length > 0)
            ? config.systems
            : [config.system]; // Use single global system prompt or undefined

    const totalResponsesToGenerate = config.prompts.length * config.models.length * temperaturesToRun.length * systemPromptsToRun.length;
    logger.info(`[PipelineService] Preparing to generate ${totalResponsesToGenerate} responses across ${temperaturesToRun.length} temperature(s) and ${systemPromptsToRun.length} system prompt(s).`);

    config.prompts.forEach(promptConfig => {
        // Ensure messages is not undefined, as loadAndValidateConfig should have populated it.
        if (!promptConfig.messages) {
            logger.error(`[PipelineService] CRITICAL: promptConfig.messages is undefined for prompt ID '${promptConfig.id}' after validation. This should not happen.`);
            // Skip this prompt or throw error
            return;
        }

        const currentPromptData: PromptResponseData = {
            promptId: promptConfig.id,
            promptText: promptConfig.promptText, // Keep for backward compatibility / reference
            initialMessages: promptConfig.messages, // Store the input messages
            idealResponseText: promptConfig.idealResponse || null,
            modelResponses: new Map()
        };
        allResponsesMap.set(promptConfig.id, currentPromptData);

        config.models.forEach(modelString => {
            temperaturesToRun.forEach(tempValue => {
                systemPromptsToRun.forEach((systemPromptValue, sp_idx) => {
                    tasks.push(limit(async () => {
                        // When permuting system prompts, there should be no per-prompt override (enforced by validation).
                        // If not permuting, a per-prompt override takes precedence over the single global system prompt.
                        const systemPromptToUse = (config.systems && config.systems.length > 0)
                            ? systemPromptValue
                            : (promptConfig.system !== undefined ? promptConfig.system : config.system);

                        // Prioritize temp from the temperatures array, then prompt-specific, then global, then the hardcoded default.
                        const temperatureForThisCall = tempValue ?? promptConfig.temperature ?? config.temperature ?? DEFAULT_TEMPERATURE;
    
                        // The ID should be consistent for a model/temperature/system_prompt_idx variant across the entire run.
                        let finalEffectiveId = modelString;
                        if (temperatureForThisCall !== undefined) {
                            finalEffectiveId = `${finalEffectiveId}[temp:${temperatureForThisCall.toFixed(1)}]`;
                        }
                        if (config.systems && config.systems.length > 1) { // Only add suffix if there's more than one to avoid clutter
                            finalEffectiveId = `${finalEffectiveId}[sp_idx:${sp_idx}]`;
                        }
                        
                        let finalAssistantResponseText = '';
                        let fullConversationHistoryWithResponse: ConversationMessage[] = [];
                        let hasError = false;
                        let errorMessage: string | undefined;

                        // loadAndValidateConfig ensures promptConfig.messages is always populated.
                        const messagesForLlm: ConversationMessage[] = [...promptConfig.messages!];

                        // If a system prompt is determined for this call,
                        // and there isn't already a system message in messagesForLlm, prepend it.
                        if (systemPromptToUse && !messagesForLlm.find(m => m.role === 'system')) {
                            messagesForLlm.unshift({ role: 'system', content: systemPromptToUse });
                        }

                        try {
                            finalAssistantResponseText = await getModelResponse({
                                modelId: modelString,
                                messages: messagesForLlm, // Pass the messages array
                                // systemPrompt is now handled by being part of messagesForLlm if applicable
                                temperature: temperatureForThisCall,
                                useCache: useCache
                            });
                            hasError = checkForErrors(finalAssistantResponseText);
                            if (hasError) errorMessage = `Response contains error markers.`;

                            fullConversationHistoryWithResponse = [...messagesForLlm, { role: 'assistant', content: finalAssistantResponseText }];

                        } catch (error: any) {
                            errorMessage = `Failed to get response for ${finalEffectiveId}: ${error.message || String(error)}`;
                            finalAssistantResponseText = `<error>${errorMessage}</error>`;
                            hasError = true;
                            logger.error(`[PipelineService] ${errorMessage}`);
                            fullConversationHistoryWithResponse = [...messagesForLlm, { role: 'assistant', content: finalAssistantResponseText }];
                        }

                        currentPromptData.modelResponses.set(finalEffectiveId, {
                            finalAssistantResponseText,
                            fullConversationHistory: fullConversationHistoryWithResponse,
                            hasError,
                            errorMessage,
                            systemPromptUsed: systemPromptToUse ?? null
                        });
                        generatedCount++;
                        logger.info(`[PipelineService] Generated ${generatedCount}/${totalResponsesToGenerate} responses.`);
                    }));
                });
            });
        });
    });

    await Promise.all(tasks);
    logger.info(`[PipelineService] Finished generating ${generatedCount}/${totalResponsesToGenerate} responses.`);
    return allResponsesMap;
}

async function aggregateAndSaveResults(
    config: ComparisonConfig,
    runLabel: string,
    allResponsesMap: Map<string, PromptResponseData>,
    evaluationResults: Partial<FinalComparisonOutputV2['evaluationResults'] & Pick<FinalComparisonOutputV2, 'extractedKeyPoints'>>,
    evalMethodsUsed: EvaluationMethod[],
    logger: Logger,
    commitSha?: string,
    blueprintFileName?: string,
): Promise<{ data: FinalComparisonOutputV2, fileName: string | null }> {
    logger.info('[PipelineService] Aggregating results...');
    logger.info(`[PipelineService] Received blueprint ID for saving: '${config.id}'`);

    const promptIds: string[] = [];
    const promptContexts: Record<string, string | ConversationMessage[]> = {}; 
    const allFinalAssistantResponses: Record<string, Record<string, string>> = {};
    const fullConversationHistories: Record<string, Record<string, ConversationMessage[]>> = {};
    const errors: Record<string, Record<string, string>> = {};
    const effectiveModelsSet = new Set<string>();
    const modelSystemPrompts: Record<string, string | null> = {};
    let hasAnyIdeal = false;

    // Determine if any ideal response exists based on the config
    if (config.prompts.some(p => p.idealResponse)) {
        hasAnyIdeal = true;
    }

    for (const [promptId, promptData] of allResponsesMap.entries()) {
        promptIds.push(promptId);
        // Store context appropriately
        if (promptData.initialMessages && promptData.initialMessages.length > 0) {
            // If it was originally multi-turn or converted from promptText, initialMessages is the source of truth for input
            promptContexts[promptId] = promptData.initialMessages;
        } else if (promptData.promptText) { // Fallback for any case where initialMessages might be missing (should not happen)
            promptContexts[promptId] = promptData.promptText;
        } else {
            promptContexts[promptId] = "Error: No input context found"; // Should not happen
        }
        
        allFinalAssistantResponses[promptId] = {};
        if (process.env.STORE_FULL_HISTORY !== 'false') { // Default to true
             fullConversationHistories[promptId] = {};
        }

        // Add ideal response text if it was part of the input
        if (promptData.idealResponseText !== null && promptData.idealResponseText !== undefined) {
            allFinalAssistantResponses[promptId][IDEAL_MODEL_ID] = promptData.idealResponseText;
            // If storing full histories, the ideal response doesn't have a "history" in the same way
        }

        for (const [effectiveModelId, responseData] of promptData.modelResponses.entries()) {
            effectiveModelsSet.add(effectiveModelId);
            allFinalAssistantResponses[promptId][effectiveModelId] = responseData.finalAssistantResponseText;
            modelSystemPrompts[effectiveModelId] = responseData.systemPromptUsed;
            
            if (responseData.fullConversationHistory && fullConversationHistories[promptId]) {
                 fullConversationHistories[promptId][effectiveModelId] = responseData.fullConversationHistory;
            }

            if (responseData.hasError && responseData.errorMessage) {
                if (!errors[promptId]) errors[promptId] = {};
                errors[promptId][effectiveModelId] = responseData.errorMessage;
            }
        }
    }

    if (hasAnyIdeal) {
        effectiveModelsSet.add(IDEAL_MODEL_ID);
    }

    const effectiveModels = Array.from(effectiveModelsSet).sort();

    const currentTimestamp = new Date().toISOString();
    const safeTimestamp = toSafeTimestamp(currentTimestamp);

    const resolvedConfigId: string = config.id!;
    const resolvedConfigTitle: string = config.title!;

    if (!resolvedConfigId) {
        logger.error(`Critical: Blueprint ID is missing. Config: ${JSON.stringify(config)}`);
        throw new Error("Blueprint ID is missing unexpectedly after validation.");
    }
    if (!resolvedConfigTitle) {
        logger.error(`Critical: Blueprint Title is missing. Config: ${JSON.stringify(config)}`);
        throw new Error("Blueprint Title is missing unexpectedly after validation.");
    }

    const finalOutput: FinalComparisonOutputV2 = {
        configId: resolvedConfigId,
        configTitle: resolvedConfigTitle,
        runLabel,
        timestamp: safeTimestamp,
        description: config.description,
        sourceCommitSha: commitSha,
        sourceBlueprintFileName: blueprintFileName,
        config: config,
        evalMethodsUsed: evalMethodsUsed,
        effectiveModels: effectiveModels,
        modelSystemPrompts: modelSystemPrompts,
        promptIds: promptIds.sort(),
        promptContexts: promptContexts,
        extractedKeyPoints: evaluationResults.extractedKeyPoints ?? undefined,
        allFinalAssistantResponses: allFinalAssistantResponses,
        fullConversationHistories: (process.env.STORE_FULL_HISTORY !== 'false') ? fullConversationHistories : undefined,
        evaluationResults: {
            similarityMatrix: evaluationResults.similarityMatrix ?? undefined,
            perPromptSimilarities: evaluationResults.perPromptSimilarities ?? undefined,
            llmCoverageScores: evaluationResults.llmCoverageScores ?? undefined,
        },
        errors: Object.keys(errors).length > 0 ? errors : undefined,
    };

    const fileName = `${runLabel}_${safeTimestamp}_comparison.json`;

    try {
        await saveResultToStorage(resolvedConfigId, fileName, finalOutput);
        logger.info(`[PipelineService] Successfully saved aggregated results to storage with key/filename: ${fileName}`);
        return { data: finalOutput, fileName: fileName };
    } catch (error: any) {
        logger.error(`[PipelineService] Failed to save the final comparison output to storage: ${error.message}`);
        return { data: finalOutput, fileName: null };
    }
}

/**
 * Main service function to execute the full comparison pipeline.
 * @param config - The comparison configuration.
 * @param runLabel - The label for the current run.
 * @param evalMethods - The evaluation methods to use.
 * @param logger - The logger for logging purposes.
 * @param existingResponsesMap - Optional map of pre-generated responses.
 * @param forcePointwiseKeyEval - Optional flag to force pointwise key evaluation.
 * @param useCache - Optional flag to enable caching for model responses.
 * @returns A promise that resolves to an object containing the full comparison data and the filename it was saved under.
 */
export async function executeComparisonPipeline(
    config: ComparisonConfig,
    runLabel: string,
    evalMethods: EvaluationMethod[],
    logger: Logger,
    // Optional: allow passing pre-generated responses to skip generation
    existingResponsesMap?: Map<string, PromptResponseData>,
    forcePointwiseKeyEval?: boolean,
    useCache: boolean = false,
    commitSha?: string,
    blueprintFileName?: string,
): Promise<{ data: FinalComparisonOutputV2, fileName: string | null }> {
    logger.info(`[PipelineService] Starting comparison pipeline for configId: '${config.id || config.configId}' runLabel: '${runLabel}'`);
    
    // Step 1: Generate all model responses if not provided
    const allResponsesMap = existingResponsesMap ?? await generateAllResponses(config, logger, useCache);
    
    // Step 2: Prepare for evaluation
    const evaluationInputs: EvaluationInput[] = [];

    for (const promptData of allResponsesMap.values()) {
        const modelIdsForThisPrompt = Array.from(promptData.modelResponses.keys());
        
        evaluationInputs.push({
            promptData: promptData,
            config: config,
            effectiveModelIds: modelIdsForThisPrompt
        });
    }

    // Step 3: Run selected evaluation methods
    const evaluators: Evaluator[] = [
        new EmbeddingEvaluator(logger),
        new LLMCoverageEvaluator(logger, useCache),
    ];

    const chosenEvaluators = evaluators.filter(e => evalMethods.includes(e.getMethodName()));
    logger.info(`[PipelineService] Will run the following evaluators: ${chosenEvaluators.map(e => e.getMethodName()).join(', ')}`);
    
    let combinedEvaluationResults: Partial<FinalComparisonOutputV2['evaluationResults'] & Pick<FinalComparisonOutputV2, 'extractedKeyPoints'>> = {
        llmCoverageScores: {},
        similarityMatrix: {},
        perPromptSimilarities: {},
        extractedKeyPoints: {}
    };

    for (const evaluator of chosenEvaluators) {
        logger.info(`[PipelineService] --- Running ${evaluator.getMethodName()} evaluator ---`);
        const results = await evaluator.evaluate(evaluationInputs);
        combinedEvaluationResults = { ...combinedEvaluationResults, ...results };
        logger.info(`[PipelineService] --- Finished ${evaluator.getMethodName()} evaluator ---`);
    }

    // Step 4: Aggregate and save results
    const finalResult = await aggregateAndSaveResults(
        config,
        runLabel,
        allResponsesMap,
        combinedEvaluationResults,
        evalMethods,
        logger,
        commitSha,
        blueprintFileName,
    );
    logger.info(`[PipelineService] executeComparisonPipeline finished successfully. Results at: ${finalResult.fileName}`);
    return finalResult;
}
