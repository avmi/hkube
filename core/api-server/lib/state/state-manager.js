const EventEmitter = require('events');
const Etcd = require('@hkube/etcd');
const storageManager = require('@hkube/storage-manager');
const { tracer } = require('@hkube/metrics');
const States = require('./States');
const ActiveState = [States.PENDING, States.ACTIVE, States.RECOVERING, States.RESUMED, States.PAUSED];
const CompletedState = [States.COMPLETED, States.FAILED, States.STOPPED];
const PausedState = [States.PAUSED];

class StateManager extends EventEmitter {
    async init(options) {
        this._etcd = new Etcd(options.etcd);
        await this._etcd.discovery.register({ serviceName: options.serviceName, data: options });
        return this._watchJobResults();
    }

    isActiveState(state) {
        return ActiveState.includes(state);
    }

    isCompletedState(state) {
        return CompletedState.includes(state);
    }

    isPausedState(state) {
        return PausedState.includes(state);
    }

    setExecution(options) {
        return this._etcd.executions.stored.set(options);
    }

    getExecution(options) {
        return this._etcd.executions.stored.get(options);
    }

    deleteExecution(options) {
        return this._etcd.executions.stored.delete(options);
    }

    setRunningPipeline(options) {
        return this._etcd.executions.running.set(options);
    }

    deleteRunningPipeline(options) {
        return this._etcd.executions.running.delete(options);
    }

    async getRunningPipelines(options, filter = () => true) {
        const runningPipelines = await this._etcd.executions.running.list(options);
        return runningPipelines.filter(filter);
    }

    getExecutionsTree(options) {
        return this._etcd.jobs.status.getExecutionsTree(options);
    }

    setAlgorithm(options) {
        return this._etcd.algorithms.store.set(options);
    }

    setPipelineDriverTemplate(options) {
        return this._etcd.pipelineDrivers.store.set(options);
    }

    getAlgorithm(options) {
        return this._etcd.algorithms.store.get(options);
    }

    getAlgorithmsQueueList(options) {
        return this._etcd.algorithms.queue.list(options);
    }

    getAlgorithms(options) {
        const { limit } = options || {};
        return this._etcd.algorithms.store.list({ ...options, limit: limit || 1000 });
    }

    deleteAlgorithm(options) {
        return this._etcd.algorithms.store.delete(options);
    }

    setAlgorithmVersion(options) {
        return this._etcd.algorithms.versions.set(options);
    }

    getAlgorithmVersion(options) {
        return this._etcd.algorithms.versions.get(options);
    }

    async getAlgorithmVersions(options, filter = () => true) {
        const versions = await this._etcd.algorithms.versions.list(options);
        return versions.filter(filter);
    }

    deleteAlgorithmVersion(options, settings) {
        return this._etcd.algorithms.versions.delete(options, settings);
    }

    setPipeline(options) {
        return this._etcd.pipelines.set(options);
    }

    getPipeline(options) {
        return this._etcd.pipelines.get(options);
    }

    async getPipelines(options, filter = () => true) {
        const pipelines = await this._etcd.pipelines.list(options);
        return pipelines.filter(filter);
    }

    deletePipeline(options) {
        return this._etcd.pipelines.delete(options);
    }

    async _watchJobResults() {
        await this._etcd.jobs.results.singleWatch();
        await this._etcd.jobs.status.singleWatch();
        this._etcd.jobs.results.on('change', (result) => {
            this.emit('job-result', result);
        });
        this._etcd.jobs.status.on('change', (result) => {
            this.emit('job-status', result);
        });
    }

    releaseJobResultsLock(options) {
        return this._etcd.jobs.results.releaseChangeLock(options);
    }

    releaseJobStatusLock(options) {
        return this._etcd.jobs.status.releaseChangeLock(options);
    }

    async getJobResult(options) {
        const result = await this._etcd.jobs.results.get(options);
        return this.getResultFromStorage(result);
    }

    async getJobResults(options) {
        const list = await this._etcd.jobs.results.list(options);
        return Promise.all(list.map(r => this.getResultFromStorage(r)));
    }

    setJobResults(options) {
        return this._etcd.jobs.results.set(options);
    }

    deleteJobResults(options) {
        return this._etcd.jobs.results.delete(options);
    }

    setWebhook(options) {
        return this._etcd.webhooks.set(options);
    }

    getWebhook(options) {
        return this._etcd.webhooks.get(options);
    }

    getWebhooks(options) {
        return this._etcd.webhooks.list(options);
    }

    deleteWebhook(options) {
        return this._etcd.webhooks.delete(options);
    }

    getJobStatus(options) {
        return this._etcd.jobs.status.get(options);
    }

    getJobStatuses(options) {
        return this._etcd.jobs.status.list(options);
    }

    setJobStatus(options) {
        return this._etcd.jobs.status.set(options);
    }

    updateJobStatus(options) {
        return this._etcd.jobs.status.update(options);
    }

    deleteJobStatus(options) {
        return this._etcd.jobs.status.delete(options);
    }

    async getResultFromStorage(options) {
        if (options && options.data && options.data.storageInfo) {
            try {
                const data = await storageManager.get(options.data.storageInfo, tracer.startSpan.bind(tracer, { name: 'storage-get-result' }));
                return { ...options, data, storageModule: storageManager.moduleName };
            }
            catch (error) {
                return { error: new Error(`failed to get from storage: ${error.message}`) };
            }
        }
        return options;
    }

    async getBuilds(options, filter = () => true) {
        const builds = await this._etcd.algorithms.builds.list(options);
        return builds.filter(filter);
    }

    async getBuild(options) {
        return this._etcd.algorithms.builds.get(options);
    }

    async setBuild(options) {
        await this._etcd.algorithms.builds.set(options);
    }

    async updateBuild(options) {
        await this._etcd.algorithms.builds.update(options);
    }

    async deleteBuild(options) {
        await this._etcd.algorithms.builds.delete(options);
    }
}

module.exports = new StateManager();
