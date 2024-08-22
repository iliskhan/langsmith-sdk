import { Client } from "../index.js";
import { getLangchainCallbacks } from "../langchain.js";
import { traceable } from "../traceable.js";
import { getDefaultRevisionId, getGitInfo } from "../utils/_git.js";
import { assertUuid } from "../utils/_uuid.js";
import { AsyncCaller } from "../utils/async_caller.js";
import { atee } from "../utils/atee.js";
import { getLangChainEnvVarsMetadata } from "../utils/env.js";
import { printErrorStackTrace } from "../utils/error.js";
import { randomName } from "./_random_name.js";
import { runEvaluator, } from "./evaluator.js";
import { v4 as uuidv4 } from "uuid";
export function evaluate(
/**
 * The target system or function to evaluate.
 */
target, options) {
    return _evaluate(target, options);
}
/**
 * Manage the execution of experiments.
 *
 * Supports lazily running predictions and evaluations in parallel to facilitate
 * result streaming and early debugging.
 */
class _ExperimentManager {
    get experimentName() {
        if (this._experimentName) {
            return this._experimentName;
        }
        else {
            throw new Error("Experiment name not provided, and experiment not yet started.");
        }
    }
    async getExamples() {
        if (!this._examples) {
            if (!this._data) {
                throw new Error("Data not provided in this experiment.");
            }
            const unresolvedData = _resolveData(this._data, { client: this.client });
            if (!this._examples) {
                this._examples = [];
            }
            const exs = [];
            for await (const example of unresolvedData) {
                exs.push(example);
            }
            if (this._numRepetitions && this._numRepetitions > 0) {
                const repeatedExamples = [];
                for (let i = 0; i < this._numRepetitions; i++) {
                    repeatedExamples.push(...exs);
                }
                this.setExamples(repeatedExamples);
            }
            else {
                this.setExamples(exs);
            }
        }
        return this._examples;
    }
    setExamples(examples) {
        this._examples = examples;
    }
    get datasetId() {
        return this.getExamples().then((examples) => {
            if (examples.length === 0) {
                throw new Error("No examples found in the dataset.");
            }
            if (this._experiment && this._experiment.reference_dataset_id) {
                return this._experiment.reference_dataset_id;
            }
            return examples[0].dataset_id;
        });
    }
    get evaluationResults() {
        if (this._evaluationResults === undefined) {
            return async function* () {
                for (const _ of await this.getExamples()) {
                    yield { results: [] };
                }
            }.call(this);
        }
        else {
            return this._evaluationResults;
        }
    }
    get runs() {
        if (this._runsArray && this._runsArray.length > 0) {
            throw new Error("Runs already provided as an array.");
        }
        if (this._runs === undefined) {
            throw new Error("Runs not provided in this experiment. Please predict first.");
        }
        else {
            return this._runs;
        }
    }
    constructor(args) {
        Object.defineProperty(this, "_data", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_runs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_evaluationResults", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_summaryResults", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_examples", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_numRepetitions", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_runsArray", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "client", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_experiment", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_experimentName", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_metadata", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_description", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.client = args.client ?? new Client();
        if (!args.experiment) {
            this._experimentName = randomName();
        }
        else if (typeof args.experiment === "string") {
            this._experimentName = `${args.experiment}-${uuidv4().slice(0, 8)}`;
        }
        else {
            if (!args.experiment.name) {
                throw new Error("Experiment must have a name");
            }
            this._experimentName = args.experiment.name;
            this._experiment = args.experiment;
        }
        let metadata = args.metadata || {};
        if (!("revision_id" in metadata)) {
            metadata = {
                revision_id: getLangChainEnvVarsMetadata().revision_id,
                ...metadata,
            };
        }
        this._metadata = metadata;
        if (args.examples && args.examples.length) {
            this.setExamples(args.examples);
        }
        this._data = args.data;
        if (args._runsArray && args._runsArray.length) {
            this._runsArray = args._runsArray;
        }
        this._runs = args.runs;
        this._evaluationResults = args.evaluationResults;
        this._summaryResults = args.summaryResults;
        this._numRepetitions = args.numRepetitions;
    }
    _getExperiment() {
        if (!this._experiment) {
            throw new Error("Experiment not yet started.");
        }
        return this._experiment;
    }
    async _getExperimentMetadata() {
        let projectMetadata = this._metadata ?? {};
        const gitInfo = await getGitInfo();
        if (gitInfo) {
            projectMetadata = {
                ...projectMetadata,
                git: gitInfo,
            };
        }
        if (this._experiment) {
            const experimentMetadata = this._experiment.extra && "metadata" in this._experiment.extra
                ? this._experiment.extra.metadata
                : {};
            projectMetadata = {
                ...experimentMetadata,
                ...projectMetadata,
            };
        }
        return projectMetadata;
    }
    async _getProject(firstExample) {
        let project;
        if (!this._experiment) {
            try {
                const projectMetadata = await this._getExperimentMetadata();
                project = await this.client.createProject({
                    projectName: this.experimentName,
                    referenceDatasetId: firstExample.dataset_id,
                    metadata: projectMetadata,
                    description: this._description,
                });
                this._experiment = project;
            }
            catch (e) {
                if (String(e).includes("already exists")) {
                    throw e;
                }
                throw new Error(`Experiment ${this._experimentName} already exists. Please use a different name.`);
            }
        }
        else {
            project = this._experiment;
        }
        return project;
    }
    async _printExperimentStart() {
        console.log(`Starting evaluation of experiment: ${this.experimentName}`);
        const firstExample = this._examples?.[0];
        const datasetId = firstExample?.dataset_id;
        if (!datasetId || !this._experiment)
            return;
        const datasetUrl = await this.client.getDatasetUrl({ datasetId });
        const compareUrl = `${datasetUrl}/compare?selectedSessions=${this._experiment.id}`;
        console.log(`View results at ${compareUrl}`);
    }
    async start() {
        const examples = await this.getExamples();
        const firstExample = examples[0];
        const project = await this._getProject(firstExample);
        await this._printExperimentStart();
        this._metadata["num_repetitions"] = this._numRepetitions;
        return new _ExperimentManager({
            examples,
            experiment: project,
            metadata: this._metadata,
            client: this.client,
            evaluationResults: this._evaluationResults,
            summaryResults: this._summaryResults,
        });
    }
    async withPredictions(target, options) {
        const experimentResults = this._predict(target, options);
        return new _ExperimentManager({
            examples: await this.getExamples(),
            experiment: this._experiment,
            metadata: this._metadata,
            client: this.client,
            runs: (async function* () {
                for await (const pred of experimentResults) {
                    yield pred.run;
                }
            })(),
        });
    }
    async withEvaluators(evaluators, options) {
        const resolvedEvaluators = _resolveEvaluators(evaluators);
        const experimentResults = this._score(resolvedEvaluators, options);
        const [r1, r2] = atee(experimentResults);
        return new _ExperimentManager({
            examples: await this.getExamples(),
            experiment: this._experiment,
            metadata: this._metadata,
            client: this.client,
            runs: (async function* () {
                for await (const result of r1) {
                    yield result.run;
                }
            })(),
            evaluationResults: (async function* () {
                for await (const result of r2) {
                    yield result.evaluationResults;
                }
            })(),
            summaryResults: this._summaryResults,
        });
    }
    async withSummaryEvaluators(summaryEvaluators) {
        const aggregateFeedbackGen = this._applySummaryEvaluators(summaryEvaluators);
        return new _ExperimentManager({
            examples: await this.getExamples(),
            experiment: this._experiment,
            metadata: this._metadata,
            client: this.client,
            runs: this.runs,
            _runsArray: this._runsArray,
            evaluationResults: this._evaluationResults,
            summaryResults: aggregateFeedbackGen,
        });
    }
    async *getResults() {
        const examples = await this.getExamples();
        const evaluationResults = [];
        if (!this._runsArray) {
            this._runsArray = [];
            for await (const run of this.runs) {
                this._runsArray.push(run);
            }
        }
        for await (const evaluationResult of this.evaluationResults) {
            evaluationResults.push(evaluationResult);
        }
        for (let i = 0; i < this._runsArray.length; i++) {
            yield {
                run: this._runsArray[i],
                example: examples[i],
                evaluationResults: evaluationResults[i],
            };
        }
    }
    async getSummaryScores() {
        if (!this._summaryResults) {
            return { results: [] };
        }
        const results = [];
        for await (const evaluationResultsGenerator of this._summaryResults) {
            if (typeof evaluationResultsGenerator === "function") {
                // This is because runs array is not available until after this generator
                // is set, so we need to pass it like so.
                for await (const evaluationResults of evaluationResultsGenerator(this._runsArray ?? [])) {
                    results.push(...evaluationResults.results);
                }
            }
        }
        return { results };
    }
    // Private methods
    /**
     * Run the target function or runnable on the examples.
     * @param {TargetT} target The target function or runnable to evaluate.
     * @param options
     * @returns {AsyncGenerator<_ForwardResults>} An async generator of the results.
     */
    async *_predict(target, options) {
        const maxConcurrency = options?.maxConcurrency ?? 0;
        const examples = await this.getExamples();
        if (maxConcurrency === 0) {
            for (const example of examples) {
                yield await _forward(target, example, this.experimentName, this._metadata, this.client);
            }
        }
        else {
            const caller = new AsyncCaller({
                maxConcurrency,
            });
            const futures = [];
            for await (const example of examples) {
                futures.push(caller.call(_forward, target, example, this.experimentName, this._metadata, this.client));
            }
            for await (const future of futures) {
                yield future;
            }
        }
        // Close out the project.
        await this._end();
    }
    async _runEvaluators(evaluators, currentResults, fields) {
        const { run, example, evaluationResults } = currentResults;
        for (const evaluator of evaluators) {
            try {
                const options = {
                    reference_example_id: example.id,
                    project_name: "evaluators",
                    metadata: {
                        example_version: example.modified_at
                            ? new Date(example.modified_at).toISOString()
                            : new Date(example.created_at).toISOString(),
                    },
                    client: fields.client,
                };
                const evaluatorResponse = await evaluator.evaluateRun(run, example, options);
                evaluationResults.results.push(...(await fields.client.logEvaluationFeedback(evaluatorResponse, run)));
            }
            catch (e) {
                console.error(`Error running evaluator ${evaluator.evaluateRun.name} on run ${run.id}: ${e}`);
                printErrorStackTrace(e);
            }
        }
        return {
            run,
            example,
            evaluationResults,
        };
    }
    /**
     * Run the evaluators on the prediction stream.
     * Expects runs to be available in the manager.
     * (e.g. from a previous prediction step)
     * @param {Array<RunEvaluator>} evaluators
     * @param {number} maxConcurrency
     */
    async *_score(evaluators, options) {
        const { maxConcurrency = 0 } = options || {};
        if (maxConcurrency === 0) {
            for await (const currentResults of this.getResults()) {
                yield this._runEvaluators(evaluators, currentResults, {
                    client: this.client,
                });
            }
        }
        else {
            const caller = new AsyncCaller({
                maxConcurrency,
            });
            const futures = [];
            for await (const currentResults of this.getResults()) {
                futures.push(caller.call(this._runEvaluators, evaluators, currentResults, {
                    client: this.client,
                }));
            }
            for (const result of futures) {
                yield result;
            }
        }
    }
    async *_applySummaryEvaluators(summaryEvaluators) {
        const projectId = this._getExperiment().id;
        const examples = await this.getExamples();
        const options = Array.from({ length: summaryEvaluators.length }).map(() => ({
            project_name: "evaluators",
            experiment: this.experimentName,
            projectId: projectId,
        }));
        const wrappedEvaluators = await wrapSummaryEvaluators(summaryEvaluators, options);
        yield async function* (runsArray) {
            const aggregateFeedback = [];
            for (const evaluator of wrappedEvaluators) {
                try {
                    const summaryEvalResult = await evaluator(runsArray, examples);
                    const flattenedResults = this.client._selectEvalResults(summaryEvalResult);
                    aggregateFeedback.push(...flattenedResults);
                    for (const result of flattenedResults) {
                        const { targetRunId, ...feedback } = result;
                        const evaluatorInfo = feedback.evaluatorInfo;
                        delete feedback.evaluatorInfo;
                        await this.client.createFeedback(null, "key", {
                            ...feedback,
                            projectId: projectId,
                            sourceInfo: evaluatorInfo,
                        });
                    }
                }
                catch (e) {
                    console.error(`Error running summary evaluator ${evaluator.name}: ${JSON.stringify(e, null, 2)}`);
                    printErrorStackTrace(e);
                }
            }
            yield {
                results: aggregateFeedback,
            };
        }.bind(this);
    }
    async _getDatasetVersion() {
        const examples = await this.getExamples();
        const modifiedAt = examples.map((ex) => ex.modified_at);
        // Python might return microseconds, which we need
        // to account for when comparing dates.
        const modifiedAtTime = modifiedAt.map((date) => {
            function getMiliseconds(isoString) {
                const time = isoString.split("T").at(1);
                if (!time)
                    return "";
                const regex = /[0-9]{2}:[0-9]{2}:[0-9]{2}.([0-9]+)/;
                const strMiliseconds = time.match(regex)?.[1];
                return strMiliseconds ?? "";
            }
            const jsDate = new Date(date);
            let source = getMiliseconds(date);
            let parsed = getMiliseconds(jsDate.toISOString());
            const length = Math.max(source.length, parsed.length);
            source = source.padEnd(length, "0");
            parsed = parsed.padEnd(length, "0");
            const microseconds = (Number.parseInt(source, 10) - Number.parseInt(parsed, 10)) / 1000;
            const time = jsDate.getTime() + microseconds;
            return { date, time };
        });
        if (modifiedAtTime.length === 0)
            return undefined;
        return modifiedAtTime.reduce((max, current) => (current.time > max.time ? current : max), modifiedAtTime[0]).date;
    }
    async _getDatasetSplits() {
        const examples = await this.getExamples();
        const allSplits = examples.reduce((acc, ex) => {
            if (ex.metadata && ex.metadata.dataset_split) {
                if (Array.isArray(ex.metadata.dataset_split)) {
                    ex.metadata.dataset_split.forEach((split) => acc.add(split));
                }
                else if (typeof ex.metadata.dataset_split === "string") {
                    acc.add(ex.metadata.dataset_split);
                }
            }
            return acc;
        }, new Set());
        return allSplits.size ? Array.from(allSplits) : undefined;
    }
    async _end() {
        const experiment = this._experiment;
        if (!experiment) {
            throw new Error("Experiment not yet started.");
        }
        const projectMetadata = await this._getExperimentMetadata();
        projectMetadata["dataset_version"] = await this._getDatasetVersion();
        projectMetadata["dataset_splits"] = await this._getDatasetSplits();
        // Update revision_id if not already set
        if (!projectMetadata["revision_id"]) {
            projectMetadata["revision_id"] = await getDefaultRevisionId();
        }
        await this.client.updateProject(experiment.id, {
            endTime: new Date().toISOString(),
            metadata: projectMetadata,
        });
    }
}
/**
 * Represents the results of an evaluate() call.
 * This class provides an iterator interface to iterate over the experiment results
 * as they become available. It also provides methods to access the experiment name,
 * the number of results, and to wait for the results to be processed.
 */
class ExperimentResults {
    constructor(experimentManager) {
        Object.defineProperty(this, "manager", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "results", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "processedCount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 0
        });
        Object.defineProperty(this, "summaryResults", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.manager = experimentManager;
    }
    get experimentName() {
        return this.manager.experimentName;
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    async next() {
        if (this.processedCount < this.results.length) {
            const result = this.results[this.processedCount];
            this.processedCount++;
            return Promise.resolve({ value: result, done: false });
        }
        else {
            return Promise.resolve({ value: undefined, done: true });
        }
    }
    async processData(manager) {
        for await (const item of manager.getResults()) {
            this.results.push(item);
            this.processedCount++;
        }
        this.summaryResults = await manager.getSummaryScores();
    }
    get length() {
        return this.results.length;
    }
}
async function _evaluate(target, fields) {
    const client = fields.client ?? new Client();
    const runs = _isCallable(target) ? null : target;
    const [experiment_, newRuns] = await _resolveExperiment(fields.experiment ?? null, runs, client);
    let manager = await new _ExperimentManager({
        data: Array.isArray(fields.data) ? undefined : fields.data,
        examples: Array.isArray(fields.data) ? fields.data : undefined,
        client,
        metadata: fields.metadata,
        experiment: experiment_ ?? fields.experimentPrefix,
        runs: newRuns ?? undefined,
        numRepetitions: fields.numRepetitions ?? 1,
    }).start();
    if (_isCallable(target)) {
        manager = await manager.withPredictions(target, {
            maxConcurrency: fields.maxConcurrency,
        });
    }
    if (fields.evaluators) {
        manager = await manager.withEvaluators(fields.evaluators, {
            maxConcurrency: fields.maxConcurrency,
        });
    }
    if (fields.summaryEvaluators) {
        manager = await manager.withSummaryEvaluators(fields.summaryEvaluators);
    }
    // Start consuming the results.
    const results = new ExperimentResults(manager);
    await results.processData(manager);
    return results;
}
async function _forward(fn, example, experimentName, metadata, client) {
    let run = null;
    const _getRun = (r) => {
        run = r;
    };
    const options = {
        reference_example_id: example.id,
        on_end: _getRun,
        project_name: experimentName,
        metadata: {
            ...metadata,
            example_version: example.modified_at
                ? new Date(example.modified_at).toISOString()
                : new Date(example.created_at).toISOString(),
        },
        client,
        tracingEnabled: true,
    };
    const wrappedFn = "invoke" in fn
        ? traceable(async (inputs) => {
            const callbacks = await getLangchainCallbacks();
            return fn.invoke(inputs, { callbacks });
        }, options)
        : traceable(fn, options);
    try {
        await wrappedFn(example.inputs);
    }
    catch (e) {
        console.error(`Error running target function: ${e}`);
        printErrorStackTrace(e);
    }
    if (!run) {
        throw new Error(`Run not created by target function.
This is most likely due to tracing not being enabled.\n
Try setting "LANGSMITH_TRACING=true" in your environment.`);
    }
    return {
        run,
        example,
    };
}
function _resolveData(data, options) {
    let isUUID = false;
    try {
        if (typeof data === "string") {
            assertUuid(data);
            isUUID = true;
        }
    }
    catch (_) {
        isUUID = false;
    }
    if (typeof data === "string" && isUUID) {
        return options.client.listExamples({
            datasetId: data,
        });
    }
    if (typeof data === "string") {
        return options.client.listExamples({
            datasetName: data,
        });
    }
    return data;
}
async function wrapSummaryEvaluators(evaluators, optionsArray) {
    async function _wrap(evaluator) {
        const evalName = evaluator.name || "BatchEvaluator";
        const wrapperInner = (runs, examples) => {
            const wrapperSuperInner = traceable((_runs_, _examples_) => {
                return Promise.resolve(evaluator(runs, examples));
            }, { ...optionsArray, name: evalName });
            return Promise.resolve(wrapperSuperInner(`Runs[] (Length=${runs.length})`, `Examples[] (Length=${examples.length})`));
        };
        return wrapperInner;
    }
    const results = [];
    for (let i = 0; i < evaluators.length; i++) {
        results.push(await _wrap(evaluators[i]));
    }
    return results;
}
function _resolveEvaluators(evaluators) {
    const results = [];
    for (const evaluator of evaluators) {
        if ("evaluateRun" in evaluator) {
            results.push(evaluator);
            // todo fix this by porting LangChainStringEvaluator to langsmith sdk
        }
        else if (evaluator.name === "LangChainStringEvaluator") {
            throw new Error("Not yet implemented");
        }
        else {
            results.push(runEvaluator(evaluator));
        }
    }
    return results;
}
async function _resolveExperiment(experiment, runs, client) {
    // TODO: Remove this, handle outside the manager
    if (experiment !== null) {
        if (!experiment.name) {
            throw new Error("Experiment name must be defined if provided.");
        }
        return [experiment, undefined];
    }
    // If we have runs, that means the experiment was already started.
    if (runs !== null) {
        const results = [];
        for await (const item of atee(runs)) {
            results.push(item);
        }
        const [runsClone, runsOriginal] = results;
        const runsCloneIterator = runsClone[Symbol.asyncIterator]();
        // todo: this is `any`. does it work properly?
        const firstRun = await runsCloneIterator
            .next()
            .then((result) => result.value);
        const retrievedExperiment = await client.readProject(firstRun.sessionId);
        if (!retrievedExperiment.name) {
            throw new Error("Experiment name not found for provided runs.");
        }
        return [retrievedExperiment, runsOriginal];
    }
    return [undefined, undefined];
}
function _isCallable(target) {
    return Boolean(typeof target === "function" ||
        ("invoke" in target && typeof target.invoke === "function"));
}
