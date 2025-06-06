import { Command } from 'commander';

import { getConfig } from '../config';
import fs from 'fs/promises';
import path from 'path';

import {
    EvaluationMethod,
    ComparisonConfig,
} from '../types/comparison_v2';
import { ComparisonDataV2 as FetchedComparisonData } from '../../app/utils/types';
import {
    getHomepageSummary,
    saveHomepageSummary,
    updateSummaryDataWithNewRun,
    getResultByFileName, // To fetch the result if executeComparisonPipeline only returns a key/path
    HomepageSummaryFileContent // Import the main type
} from '../../lib/storageService'; // Adjusted path
import {
    calculateHeadlineStats,
    calculatePotentialModelDrift
} from '../utils/summaryCalculationUtils'; // Import new calc utils

import { executeComparisonPipeline } from '../services/comparison-pipeline-service';
import { generateConfigContentHash } from '../../lib/hash-utils';

async function loadAndValidateConfig(configPath: string, collectionsRepoPath?: string): Promise<ComparisonConfig> {
    const { logger } = getConfig();
    logger.info(`Loading and validating config file: ${path.resolve(configPath)}`);
    if (collectionsRepoPath) {
        logger.info(`Attempting to resolve model collections from local path: ${path.resolve(collectionsRepoPath)}`);
    }
    
    let configContent;
    try {
        configContent = await fs.readFile(path.resolve(configPath), 'utf-8');
    } catch (fileReadError: any) {
        logger.error(`Failed to read configuration file at '${path.resolve(configPath)}'. Please ensure the file exists and has correct permissions.`);
        logger.error(`System error: ${fileReadError.message}`);
        throw fileReadError;
    }

    let configJson: ComparisonConfig;
    try {
        configJson = JSON.parse(configContent);
    } catch (parseError: any) {
        logger.error(`Failed to parse JSON from configuration file at '${path.resolve(configPath)}'. Please ensure it is valid JSON.`);
        logger.error(`System error: ${parseError.message}`);
        throw parseError;
    }
    
    // Basic validation (pre-collection resolution)
    if (!configJson.id && !configJson.configId) {
        throw new Error("Config file missing or has invalid 'id' or 'configId'");
    }
    if (configJson.id && (typeof configJson.id !== 'string' || configJson.id.trim() === '')) {
        throw new Error("Config file has invalid 'id' (must be a non-empty string if provided)");
    }
    if (!configJson.id && configJson.configId && (typeof configJson.configId !== 'string' || configJson.configId.trim() === '')) {
        throw new Error("Config file has invalid 'configId' (must be a non-empty string if 'id' is not provided)");
    }
    
    if (configJson.title && (typeof configJson.title !== 'string' || configJson.title.trim() === '')) {
        throw new Error("Config file has invalid 'title' (must be a non-empty string if provided)");
    }
    if (!configJson.title && configJson.configTitle && (typeof configJson.configTitle !== 'string' || configJson.configTitle.trim() === '')) {
        throw new Error("Config file has invalid 'configTitle' (must be a non-empty string if 'title' is not provided)");
    }

    if (!configJson.models || !Array.isArray(configJson.models) || configJson.models.length === 0) {
        logger.info('Models field is missing, not an array, or empty. Defaulting to ["CORE"].');
        configJson.models = ["CORE"];
    }

    if (!Array.isArray(configJson.models)) { // Prompts validation can remain, models array structure is key here
        throw new Error("Config file 'models' field must be an array.");
    }
    if (!Array.isArray(configJson.prompts)) {
        throw new Error("Config file missing or has invalid 'prompts' (must be an array).");
    }

    logger.info(`Initial validation passed for configId '${configJson.configId || configJson.id}'. Original models: [${configJson.models.join(', ')}]`);

    const originalModels = [...configJson.models];
    const resolvedModels: string[] = [];
    let collectionResolutionAttempted = false;

    for (const modelEntry of originalModels) {
        if (typeof modelEntry === 'string' && !modelEntry.includes(':') && modelEntry.toUpperCase() === modelEntry) { // Placeholder: no colon, all caps
            collectionResolutionAttempted = true;
            if (!collectionsRepoPath) {
                logger.warn(`Model entry '${modelEntry}' in '${configPath}' looks like a collection placeholder, but --collections-repo-path was not provided. Treating '${modelEntry}' as a literal model ID for now.`);
                resolvedModels.push(modelEntry); // Add as is, might fail later if not a real model ID
                continue;
            }

            logger.info(`Found model collection placeholder: '${modelEntry}'. Attempting to load from local collections path.`);
            const collectionFileName = `${modelEntry}.json`;
            const collectionFilePath = path.join(path.resolve(collectionsRepoPath), 'models', collectionFileName);
            
            try {
                logger.info(`Reading model collection file: ${collectionFilePath}`);
                const collectionContent = await fs.readFile(collectionFilePath, 'utf-8');
                const collectionArray = JSON.parse(collectionContent);

                if (Array.isArray(collectionArray) && collectionArray.every(m => typeof m === 'string')) {
                    logger.info(`Successfully loaded and parsed model collection '${modelEntry}' from ${collectionFilePath}. Found ${collectionArray.length} models.`);
                    resolvedModels.push(...collectionArray);
                } else {
                    const errorMsg = `Invalid format for local model collection '${modelEntry}' at ${collectionFilePath}. Expected a JSON array of strings.`;
                    logger.error(errorMsg);
                    throw new Error(errorMsg);
                }
            } catch (collectionError: any) {
                if (collectionError.code === 'ENOENT') {
                    const errorMsg = `Model collection file not found for placeholder '${modelEntry}' at expected path: ${collectionFilePath}. This is required when --collections-repo-path is specified.`;
                    logger.error(errorMsg);
                    throw new Error(errorMsg);
                } else {
                    const errorMsg = `Error reading or parsing local model collection '${modelEntry}' from ${collectionFilePath}: ${collectionError.message}`;
                    logger.error(errorMsg);
                    throw new Error(errorMsg);
                }
            }
        } else if (typeof modelEntry === 'string') {
            resolvedModels.push(modelEntry);
        } else {
            logger.warn(`Invalid non-string entry in models array found in '${configPath}': ${JSON.stringify(modelEntry)}. Skipping this entry.`);
        }
    }

    if (collectionResolutionAttempted && !collectionsRepoPath) {
        logger.info('Note: Some model entries looked like collection placeholders, but no --collections-repo-path was provided. Placeholders were treated as literal model IDs.');
    }

    configJson.models = [...new Set(resolvedModels)]; // Deduplicate
    const finalId = configJson.id || configJson.configId!;
    logger.info(`Final resolved models for blueprint ID '${finalId}': [${configJson.models.join(', ')}] (Count: ${configJson.models.length})`);
    if (originalModels.length > 0 && configJson.models.length === 0) {
        logger.warn(`Blueprint file '${configPath}' resulted in an empty list of models after attempting to resolve collections. Original models: [${originalModels.join(',')}]. Check blueprint and collection definitions.`);
    }

    // Post-resolution validation (other fields)
    if (configJson.description) {
        logger.info(`Description found in config: ${configJson.description.substring(0, 100)}...`);
    }
    if (configJson.temperature !== undefined && typeof configJson.temperature !== 'number') {
        throw new Error("Config file has invalid 'temperature'");
    }
    if (configJson.temperatures !== undefined && (!Array.isArray(configJson.temperatures) || !configJson.temperatures.every((t: any) => typeof t === 'number'))) {
        throw new Error("Config file has invalid 'temperatures'");
    }
    if (configJson.tags !== undefined) {
        if (!Array.isArray(configJson.tags) || !configJson.tags.every((tag: any) => typeof tag === 'string')) {
            throw new Error("Config file has an invalid 'tags' field (must be an array of strings if provided).");
        }
        logger.info(`Tags found in config: ${configJson.tags.join(', ')}`);
    }
    if (configJson.temperature !== undefined && configJson.temperature !== null &&
        Array.isArray(configJson.temperatures) && configJson.temperatures.length > 0) {
        logger.warn(`Warning: Both 'temperature' (value: ${configJson.temperature}) and a non-empty 'temperatures' array are defined. The 'temperature' field will be ignored.`);
    }

    const finalTitle = configJson.title || configJson.configTitle!;
    logger.info(`Blueprint for '${finalId}' (Title: '${finalTitle}') loaded, validated, and models resolved successfully.`);
    return configJson;
}

function parseEvalMethods(evalMethodString: string | undefined): EvaluationMethod[] {
    if (!evalMethodString) return ['embedding'];

    const methods = evalMethodString.split(',').map(m => m.trim().toLowerCase()).filter(m => m);
    const validMethods: EvaluationMethod[] = ['embedding', 'llm-coverage'];
    const chosenMethods: EvaluationMethod[] = [];

    if (methods.includes('all')) {
        return validMethods;
    }

    methods.forEach((method) => {
        if (validMethods.includes(method as EvaluationMethod)) {
            chosenMethods.push(method as EvaluationMethod);
        } else {
            const logger = getConfig()?.logger;
            const logFn = logger ? logger.warn : console.warn;
            logFn(`[ParseEvalMethods] Invalid evaluation method ignored: ${method}`);
        }
    });
    
    if (chosenMethods.length === 0) {
        const logger = getConfig()?.logger;
        const logFn = logger ? logger.warn : console.warn;
        logFn('[ParseEvalMethods] No valid evaluation methods found or specified. Defaulting to embedding.');
        return ['embedding'];
    }
    return chosenMethods;
}

async function actionV2(options: { config: string, runLabel?: string, evalMethod?: string, cache?: boolean, collectionsRepoPath?: string }) {
    let loggerInstance: ReturnType<typeof getConfig>['logger'];
    try {
        const configService = getConfig();
        loggerInstance = configService.logger;
    } catch (e: any) {
        console.error('[CivicEval_RUN_CONFIG_CRITICAL] Error during initial logger setup:', e.message, e.stack);
        process.exit(1);
    }

    try {
        await loggerInstance.info(`CivicEval run_config CLI started. Options received: ${JSON.stringify(options)}`);
        
        const config = await loadAndValidateConfig(options.config, options.collectionsRepoPath);
        const currentConfigId = config.id || config.configId!;
        const currentTitle = config.title || config.configTitle!;
        
        await loggerInstance.info(`Loaded blueprint ID: '${currentConfigId}', Title: '${currentTitle}' with resolved models.`);

        let runLabel = options.runLabel?.trim();
        const contentHash = generateConfigContentHash(config); // Hash is now based on resolved models
        let finalRunLabel: string;

        if (runLabel) {
            finalRunLabel = `${runLabel}_${contentHash}`;
            await loggerInstance.info(`User provided runLabel '${options.runLabel?.trim()}', appended content hash. Final runLabel: '${finalRunLabel}'`);
        } else {
            finalRunLabel = contentHash;
            await loggerInstance.info(`--run-label not supplied. Using content hash as runLabel: '${finalRunLabel}'`);
        }
        
        if (!finalRunLabel) {
            throw new Error('Run label is unexpectedly empty after processing.');
        }
        if (config.models.length === 0) {
            loggerInstance.error('The final list of models to evaluate is empty. This can happen if model collections are specified but not resolved, or if the config itself has no models. Halting execution.');
            throw new Error('No models to evaluate after resolving collections.');
        }

        const chosenMethods = parseEvalMethods(options.evalMethod);
        await loggerInstance.info(`Evaluation methods to be used: ${chosenMethods.join(', ')}`);

        await loggerInstance.info('--- Run Blueprint Summary (Post Model Collection Resolution) ---');
        await loggerInstance.info(`Blueprint ID: ${currentConfigId}`);
        await loggerInstance.info(`Blueprint Title: ${currentTitle}`);
        await loggerInstance.info(`Run Label: ${finalRunLabel}`); 
        if (config.description) {
            await loggerInstance.info(`Description: ${config.description.substring(0, 200)}...`);
        }
        await loggerInstance.info(`Models to run: [${config.models.join(', ')}] (Count: ${config.models.length})`);
        await loggerInstance.info(`Number of Prompts: ${config.prompts.length}`);
        await loggerInstance.info(`Concurrency: ${config.concurrency || 10}`);
        await loggerInstance.info(`Evaluation Methods: ${chosenMethods.join(', ')}`);
        if (config.temperatures && config.temperatures.length > 0) {
            await loggerInstance.info(`Temperatures to run: ${config.temperatures.join(', ')}`);
        } else if (config.temperature !== undefined) {
            await loggerInstance.info(`Default Temperature: ${config.temperature}`);
        }
        await loggerInstance.info('-----------------------------------------------------------------');

        const ora = (await import('ora')).default;
        const mainSpinner = ora('Starting comparison pipeline with resolved models...').start();
        let outputPathOrKey: string | null = null; // To store the result path/key
        let newResultData: FetchedComparisonData | null = null; // To store the actual data object
        let actualResultFileName: string | null = null; // To store the definitive file name of the saved result

        try {
            mainSpinner.text = `Executing comparison pipeline for blueprint ID: ${currentConfigId}, runLabel: ${finalRunLabel}. Caching: ${options.cache ?? false}`;
            
            // Assuming executeComparisonPipeline saves the file and returns its path/key
            // AND that it can also return the full data object if not saving to S3, or we fetch it after.
            const pipelineResult = await executeComparisonPipeline(
                config, 
                finalRunLabel, 
                chosenMethods, 
                loggerInstance, 
                undefined, 
                undefined, 
                options.cache
            ); 

            if (typeof pipelineResult === 'string') { // If it's a path/key from successful save
                outputPathOrKey = pipelineResult;
                actualResultFileName = path.basename(outputPathOrKey);
                
                newResultData = await getResultByFileName(currentConfigId, actualResultFileName) as FetchedComparisonData;
                if (!newResultData) {
                    mainSpinner.fail(`Comparison pipeline completed, results saved to: ${outputPathOrKey}, but failed to fetch the saved data for summary update.`);
                    process.exit(1);
                }
            } else if (typeof pipelineResult === 'object' && pipelineResult !== null && !(process.env.STORAGE_PROVIDER === 's3')) { 
                newResultData = pipelineResult as FetchedComparisonData;
                // In this case, there isn't a persisted file name in S3, so manifest update might be skipped or handled differently.
                // For now, we'll assume actualResultFileName remains null if not saved to a discoverable file.
                outputPathOrKey = `memory://for-config-${currentConfigId}-run-${finalRunLabel}`; // Conceptual path
            } else if (typeof pipelineResult === 'object' && pipelineResult !== null && process.env.STORAGE_PROVIDER === 's3'){
                // This case should ideally not happen if S3 is the provider; a key should be returned.
                // Or, if executeComparisonPipeline saved to S3 AND returned the data, we still need the filename.
                // This implies executeComparisonPipeline needs to return { data: FetchedComparisonData, fileName: string } if it saves AND returns data.
                // For now, this is an error or unhandled case for S3 manifest update.
                mainSpinner.fail('Pipeline returned data object directly but S3 provider is active and filename for manifest update is unknown.');
                process.exit(1);
            } else {
                throw new Error('executeComparisonPipeline returned an unexpected result.');
            }
            
            if (outputPathOrKey) {
              mainSpinner.succeed(`Comparison pipeline finished successfully! Results related to: ${outputPathOrKey}`);
            } else {
              mainSpinner.fail(`Comparison pipeline completed, but failed to save results or get a valid reference.`);
              process.exit(1);
            }
        } catch (pipelineError: any) {
            mainSpinner.fail(`Comparison pipeline failed: ${pipelineError.message}`);
            if (process.env.DEBUG && pipelineError.stack) {
                loggerInstance.error(`Pipeline stack trace: ${pipelineError.stack}`);
            }
            process.exit(1);
        }

        if (newResultData && (process.env.STORAGE_PROVIDER === 's3' || process.env.UPDATE_LOCAL_SUMMARY === 'true')) { // Only update if S3 or explicitly told for local
            try {
                loggerInstance.info('Attempting to update homepage summary manifest with new calculations...');
                const currentFullSummary = await getHomepageSummary(); // Fetches HomepageSummaryFileContent | null
                
                if (!actualResultFileName) {
                    throw new Error('Could not determine result filename for summary update. Result might not have been saved to a persistent location.');
                }

                // 1. Update the configs array part of the summary
                const updatedConfigsArray = updateSummaryDataWithNewRun(
                    currentFullSummary?.configs || null, // Pass only the configs array, or null if no current summary
                    newResultData, 
                    actualResultFileName
                );

                // Filter out configs with 'test' tag before calculating aggregate stats
                // These stats are for public consumption, so 'test' items should always be excluded from the *calculation*
                // of the globally cached/stored homepage summary.
                const configsForStatsCalculation = updatedConfigsArray.filter(
                    config => !(config.tags && config.tags.includes('test'))
                );
                loggerInstance.info(`Total configs for summary: ${updatedConfigsArray.length}. Configs after filtering 'test' tags for stats calculation: ${configsForStatsCalculation.length}`);

                // 2. Recalculate headlineStats and driftDetectionResult using the newly updated configs array
                const newHeadlineStats = calculateHeadlineStats(configsForStatsCalculation);
                const newDriftDetectionResult = calculatePotentialModelDrift(configsForStatsCalculation);

                // 3. Construct the complete new HomepageSummaryFileContent object
                const newHomepageSummaryContent: HomepageSummaryFileContent = {
                    configs: updatedConfigsArray,
                    headlineStats: newHeadlineStats,
                    driftDetectionResult: newDriftDetectionResult,
                    lastUpdated: new Date().toISOString(),
                };

                await saveHomepageSummary(newHomepageSummaryContent);
                loggerInstance.info('Homepage summary manifest updated successfully with re-calculated stats.');
            } catch (summaryError: any) {
                loggerInstance.error(`Failed to update homepage summary manifest: ${summaryError.message}`);
                if (process.env.DEBUG && summaryError.stack) {
                    loggerInstance.error(`Summary update stack trace: ${summaryError.stack}`);
                }
                // Do not exit process here, as the main run was successful.
            }
        } else {
            loggerInstance.info('Skipping homepage summary manifest update (not S3 provider or not explicitly enabled for local).');
        }

        await loggerInstance.info('CivicEval run_config command finished successfully.');
    } catch (error: any) {
        loggerInstance.error(`Top-level error in CivicEval run_config action: ${error.message}`);
        if (process.env.DEBUG && error.stack) {
            loggerInstance.error(`Overall stack trace: ${error.stack}`);
        }
        // Ensure spinner is stopped on error
        try {
            // If mainSpinner is in scope and is an ora instance, stop it directly.
            // However, mainSpinner is defined in the try block above and not accessible here.
            // Revert to a simpler way to stop any active ora spinner, similar to original handling.
            const ora = (await import('ora')).default;
            ora().stop(); // Assumes ora().stop() can halt any active spinner from the library.
        } catch (spinnerError: any) {
            loggerInstance.warn(`Could not stop ora spinner on error: ${spinnerError.message}`);
        }
        process.exit(1);
    }
}

export const runConfigCommand = new Command('run_config')
    .description('Runs response generation and configurable evaluations based on a JSON blueprint file. Can resolve model collections from a local path.')
    .requiredOption('-c, --config <path>', 'Path to the JSON blueprint file')
    .option('-r, --run-label <runLabelValue>', 'A unique label for this specific execution run. If not provided, a label will be generated based on the blueprint content.')
    .option('--eval-method <methods>', "Comma-separated evaluation methods (embedding, llm-coverage, all)")
    .option('--cache', 'Enable caching for model responses (defaults to false).')
    .option('--collections-repo-path <path>', 'Path to your local checkout of the civiceval/configs repository (or a similar structure) to resolve model collections from its "models" subdirectory. The evaluation blueprints themselves are expected in a "blueprints" subdirectory within this path if not using direct GitHub fetching.')
    .action(actionV2); 