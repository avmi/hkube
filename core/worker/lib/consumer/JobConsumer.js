const EventEmitter = require('events');
const { Consumer } = require('@hkube/producer-consumer');
const { tracer } = require('@hkube/metrics');
const { pipelineStatuses, taskStatuses, retryPolicy } = require('@hkube/consts');
const Logger = require('@hkube/logger');
const storage = require('../storage/storage');
const stateManager = require('../states/stateManager');
const boards = require('../boards/boards');
const metricsHelper = require('../metrics/metrics');
const stateAdapter = require('../states/stateAdapter');
const { Components, logMessages, jobStatus } = require('../consts');
const JobProvider = require('./job-provider');
const DEFAULT_RETRY = { policy: retryPolicy.OnCrash };
const pipelineDoneStatus = [pipelineStatuses.COMPLETED, pipelineStatuses.FAILED, pipelineStatuses.STOPPED];
const { MetadataPlugin } = Logger;
const component = Components.CONSUMER;
let log;

class JobConsumer extends EventEmitter {
    constructor() {
        super();
        this._consumer = null;
        this._options = null;
        this._job = null;
        this._jobId = undefined;
        this._taskId = undefined;
        this._batchIndex = undefined;
        this._pipelineName = undefined;
        this._consumerPaused = false;
        this.workerStartingTime = new Date();
        this.jobCurrentTime = null;
        this._hotWorker = false;
    }

    async init(options) {
        log = Logger.GetLogFromContainer();
        log.metadataEnrichers.use(new MetadataPlugin({
            enrichCallback: metadata => ({
                ...metadata, ...this.currentTaskInfo()
            })
        }));
        this._options = options;
        this._options.jobConsumer.setting.redis = options.redis;
        this._options.jobConsumer.setting.tracer = tracer;

        if (this._consumer) {
            this._consumer.removeAllListeners();
            this._consumer = null;
            this._job = null;
        }
        this._hotWorker = this._options.hotWorker;
        this._consumer = new Consumer(this._options.jobConsumer);
        this._jobProvider = new JobProvider(options);
        this._jobProvider.init(this._consumer);
        this._consumer.register(this._options.jobConsumer);
        log.info(`registering for job ${JSON.stringify(this._options.jobConsumer.job)}`, { component });

        this._jobProvider.on('job', async (job) => {
            if (job.data.status === taskStatuses.PRESCHEDULE) {
                log.info(`job ${job.data.jobId} is in ${job.data.status} mode, calling done...`);
                job.done();
                return;
            }
            log.info(`execute job ${job.data.jobId} with inputs: ${JSON.stringify(job.data.input)}`, { component });
            const watchState = await stateAdapter.watch({ jobId: job.data.jobId });
            if (watchState && this._isCompletedState({ status: watchState.status })) {
                await this._stopJob(job, watchState.status);
                return;
            }

            metricsHelper.initMetrics(job);
            this._setJob(job);

            if (this._execId) {
                log.info('starting as algorithm code api', { component });
                const watchExecutionState = await stateAdapter.watchAlgorithmExecutions({ jobId: this._jobId, taskId: this._taskId });
                if (watchExecutionState && this._isCompletedState({ status: watchExecutionState.status })) {
                    await this.finishJob();
                    return;
                }
            }

            await this.updateStatus({
                status: jobStatus.ACTIVE,
                startTime: Date.now()
            });

            stateManager.setJob(job);
            stateManager.prepare();
        });

        this._jobProvider.on('job-queue', async (job) => {
            this._setJob(job);
        });

        stateManager.on('finish', () => {
            this.finishBullJob();
        });
    }

    _isCompletedState({ status }) {
        return pipelineDoneStatus.includes(status);
    }

    _shouldNormalExit(options) {
        const { shouldCompleteJob } = options || {};
        return shouldCompleteJob === undefined ? true : shouldCompleteJob;
    }

    finishBullJob(options) {
        const shouldCompleteJob = this._shouldNormalExit(options);
        if (this._job && shouldCompleteJob) {
            this._job.done(this._job.error);
            log.info(`finish job ${this._jobId}`);
        }
        this._job = null;
        this._jobId = undefined;
        this._taskId = undefined;
        this._pipelineName = undefined;
        this._jobData = undefined;
        this._retry = undefined;
    }

    _setJob(job) {
        this._job = job;
        this._jobId = job.data.jobId;
        this._taskId = job.data.taskId;
        this._execId = job.data.execId;
        this._batchIndex = job.data.batchIndex;
        this._pipelineName = job.data.pipelineName;
        this._jobData = { nodeName: job.data.nodeName, batchIndex: job.data.batchIndex };
        this._retry = job.data.retry;
        this.jobCurrentTime = new Date();
    }

    async _stopJob(job, status) {
        await stateAdapter.unwatch({ jobId: job.data.jobId });
        log.info(`job ${job.data.jobId} already in ${status} status`);
        job.done();
    }

    async pause() {
        try {
            this._consumerPaused = true;
            await this._consumer.pause({ type: this._options.jobConsumer.job.type });
            log.info('Job consumer paused', { component });
        }
        catch (err) {
            this._consumerPaused = false;
            log.error(`Failed to pause consumer. Error:${err.message}`, { component });
        }
    }

    async resume() {
        try {
            this._consumerPaused = false;
            await this._consumer.resume({ type: this._options.jobConsumer.job.type });
            log.info('Job consumer resumed', { component });
        }
        catch (err) {
            this._consumerPaused = true;
            log.error(`Failed to resume consumer. Error:${err.message}`, { component });
        }
    }

    get hotWorker() {
        return this._hotWorker;
    }

    set hotWorker(value) {
        this._hotWorker = value;
    }

    async updateDiscovery(data) {
        const discoveryInfo = this.getDiscoveryData(data);
        await stateAdapter.updateDiscovery(discoveryInfo);
    }

    getDiscoveryData(data) {
        const { workerStatus, error } = this._getStatus(data);
        const discoveryInfo = {
            jobId: this._jobId,
            taskId: this._taskId,
            pipelineName: this._pipelineName,
            jobData: this._jobData,
            workerStatus,
            workerStartingTime: this.workerStartingTime,
            jobCurrentTime: this.jobCurrentTime,
            workerPaused: this.isConsumerPaused,
            hotWorker: this._hotWorker,
            error
        };
        return discoveryInfo;
    }

    _getStatus(data) {
        const { state, results, isTtlExpired } = data;
        const workerStatus = state;
        let status = state === jobStatus.WORKING ? jobStatus.ACTIVE : state;
        let error = null;
        let reason = null;
        const shouldCompleteJob = this._shouldNormalExit(results);

        if (results != null) {
            error = results.error && results.error.message;
            reason = results.error && results.error.reason;
            status = error ? jobStatus.FAILED : jobStatus.SUCCEED;
        }
        if (isTtlExpired) {
            error = logMessages.algorithmTtlExpired;
            status = jobStatus.FAILED;
        }
        const resultData = results && results.data;
        return {
            workerStatus,
            status,
            error,
            reason,
            resultData,
            shouldCompleteJob
        };
    }

    async sendWarning(warning) {
        if (!this._jobId) {
            return;
        }
        const data = {
            warning,
            status: jobStatus.WARNING
        };
        await this.updateStatus(data);
    }

    updateStatus(data = {}) {
        return stateAdapter.updateTask({ ...this._getState(), ...data });
    }

    _getState() {
        return {
            jobId: this._jobId,
            taskId: this._taskId,
            execId: this._job.data.execId,
            nodeName: this._job.data.nodeName,
            parentNodeName: this._job.data.parentNodeName,
            algorithmName: this._job.data.algorithmName,
            podName: this._options.kubernetes.pod_name,
            batchIndex: this._batchIndex
        };
    }

    async finishJob(data = {}, isTtlExpired) {
        if (!this._job) {
            return;
        }
        await stateAdapter.unwatch({ jobId: this._jobId });
        if (this._execId) {
            await stateAdapter.unwatchAlgorithmExecutions({ jobId: this._jobId, taskId: this._taskId });
        }
        const { resultData, status, error, reason, shouldCompleteJob } = this._getStatus({ ...data, isTtlExpired });

        if (shouldCompleteJob) {
            let storageResult;
            let metricsPath;
            if (!error && status === jobStatus.SUCCEED) {
                storageResult = await storage.setStorage({ data: resultData, jobData: this._job.data });
                if (!(this.jobData.metrics && this.jobData.metrics.tensorboard === false)) {
                    const tensorboard = await boards.putAlgoMetrics(this.jobData, this.jobCurrentTime);
                    (tensorboard.path || tensorboard.error) && (metricsPath = { tensorboard });
                }
            }
            const resData = {
                status,
                error,
                reason,
                endTime: Date.now(),
                metricsPath,
                ...storageResult
            };

            this._job.error = error;
            await this.updateStatus(resData);
            log.debug(`result: ${JSON.stringify(resData.result)}`, { component });
        }
        metricsHelper.summarizeMetrics({ status, jobId: this._jobId, taskId: this._taskId });
        log.info(`finishJob - status: ${status}, error: ${error}`, { component });
    }

    setStoringStatus(result) {
        return this.updateStatus({ status: jobStatus.STORING, result });
    }

    currentTaskInfo() {
        return {
            jobId: this._jobId,
            taskId: this._taskId,
            pipelineName: this._pipelineName,
            algorithmName: this.getAlgorithmType(),
            batchIndex: this._batchIndex
        };
    }

    get isConsumerPaused() {
        return this._consumerPaused;
    }

    get jobData() {
        return this._job && this._job.data;
    }

    get jobId() {
        return this._jobId;
    }

    get taskId() {
        return this._taskId;
    }

    get jobRetry() {
        return this._retry || DEFAULT_RETRY;
    }

    getAlgorithmType() {
        return this._options.jobConsumer.job.type;
    }
}

module.exports = new JobConsumer();
