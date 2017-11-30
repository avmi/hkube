const uuidv4 = require('uuid/v4');
const producer = require('lib/producer/jobs-producer');
const consumer = require('lib/consumer/jobs-consumer');
const stateManager = require('lib/state/state-manager');
const progress = require('lib/progress/nodes-progress');
const NodesMap = require('lib/nodes/nodes-map');
const States = require('lib/state/States');
const Task = require('lib/tasks/Task');
const inputParser = require('lib/parsers/input-parser');
const Batch = require('lib/nodes/batch');
const Logger = require('@hkube/logger');
const log = Logger.GetLogFromContainer();
const components = require('common/consts/componentNames');

class TaskRunner {

    constructor() {
        this._job = null;
        this._pipeline = null;
        this._nodes = null;
    }

    init(options) {
        this._config = options;
        producer.on('task-waiting', (taskId) => {
            this._updateStatus(taskId, States.PENDING);
        })
        producer.on('task-active', (taskId) => {
            this._updateStatus(taskId, States.ACTIVE);
        })
        consumer.on('job-start', async (job) => {
            try {
                await this._start(job);
            }
            catch (error) {
                this._jobComplete(error);
            }
        });
        stateManager.on('job-stop', (data) => {
            this._jobComplete(null, data.reason);
        });
        stateManager.on('task-completed', async (data) => {
            const task = await stateManager.getTaskState({ taskId: data.taskId });
            log.info(`task completed ${task.taskId}`, { component: components.TASK_RUNNER });
            task.status = data.status;
            task.result = data.result;
            this._setTaskState(task);
            this._taskComplete(task);
        });
        stateManager.on('task-failed', async (data) => {
            const task = await stateManager.getTaskState({ taskId: data.taskId });
            log.error(`task failed ${task.taskId}, error: ${data.error}`, { component: components.TASK_RUNNER });
            task.status = data.status;
            task.error = data.error;
            this._setTaskState(task);
            this._taskComplete(task);
        });
    }

    /// TODO:  stateManager.setJobResults({ error });
    async _jobComplete(error, reason) {
        await stateManager.unWatchJobState();
        await stateManager.unWatchTasks();
        const tasks = await stateManager.getDriverTasks();
        if (tasks) {
            await Promise.all(tasks.map(t => producer.stopJob({ type: t.algorithm, jobID: this._job.id })));
        }
        if (error) {
            log.error(`pipeline failed ${error}`, { component: components.TASK_RUNNER });
            progress.error({ status: States.FAILED, error: error.message });
            stateManager.setJobResults({ error });
            this._job.done(error.message);
        }
        else if (reason) {
            log.info(`pipeline stopped ${this._job.id}. ${reason}`, { component: components.TASK_RUNNER });
            progress.info({ status: States.STOPPED });
            this._job.done();
        }
        else {
            progress.info({ status: States.COMPLETED });
            log.info(`pipeline completed ${this._job.id}`, { component: components.TASK_RUNNER });
            this._job.done();
        }
        this._job = null;
        this._pipeline = null;
        this._nodes = null;
    }

    async _updateStatus(taskId, status) {
        log.info(`task ${status} ${taskId}`, { component: components.TASK_RUNNER });
        const task = await stateManager.getTaskState({ taskId: taskId });
        task.status = status;
        this._setTaskState(task);
    }

    async _start(job) {
        log.info(`pipeline started ${job.id}`, { component: components.TASK_RUNNER });
        stateManager.setCurrentJobID(job.id);
        this._job = job;

        await stateManager.watchTasks();
        const watchState = await stateManager.watchJobState();
        if (watchState && watchState.obj && watchState.obj.state === States.STOP) {
            this._jobComplete(null, watchState.obj.reason);
        }
        this._pipeline = await stateManager.getExecution({ jobId: job.id });
        this._nodes = new NodesMap(this._pipeline, this._config);

        progress.calcMethod(this._nodes.calc.bind(this._nodes));

        // first we will try to get the state for this job
        const state = await stateManager.getState();
        if (state) {
            stateManager.setState({ data: States.RECOVERING });
            this._recover(state);
        }
        else {
            stateManager.setState({ data: States.ACTIVE });
            progress.info({ status: States.ACTIVE });
            this._startPipeline(job.data);
        }
    }

    _runCompleted(nodeName) {
        const childs = this._nodes.childs(nodeName);
        childs.forEach(child => {
            const node = this._nodes.getNode(child);
            const waitAnyIndex = inputParser.waitAnyInputIndex(node.input);
            if (waitAnyIndex > -1) {
                this._runWaitAny(child, data.result);
            }
            else {
                const allFinished = this._nodes.isAllParentsFinished(child);
                if (allFinished) {
                    const results = this._nodes.parentsResults(child);
                    this._runNode(child, results);
                }
            }
        });
    }

    _runNode(nodeName, nodesInput) {
        const node = this._nodes.getNode(nodeName);
        const options = Object.assign({}, { flowInput: this._pipeline.flowInput }, { input: node.input });
        const result = inputParser.parse(options, node.input, nodesInput);
        this._runNodeInner(node, result);
    }

    _runNodeInner(node, data) {
        if (data.batch) {
            this._runBatch(node, data.input);
        }
        else {
            this._nodes.setNode(node.name, { input: data.input });
            this._createJob(node);
        }
    }

    _runBatch(node, batchArray) {
        if (!Array.isArray(batchArray)) {
            throw new Error(`node ${node.name} batch input must be an array`);
        }
        const options = Object.assign({}, this._pipeline, node);
        batchArray.forEach((inp, ind) => {
            const batch = new Batch({
                name: node.name,
                batchID: `${node.name}#${(ind + 1)}`,
                algorithm: node.algorithm,
                input: inp
            });
            this._nodes.addBatch(batch);
            this._createJob(batch);
        })
    }

    _runWaitAny(nodeName, nodeInput) {
        const node = this._nodes.getNode(nodeName);
        const waitAnyIndex = inputParser.waitAnyInputIndex(node.input);
        const input = node.input.slice();
        input.forEach((inp, ind) => {
            if (inputParser.isWaitAnyBatch(inp)) {
                const nodeInput = node.input[waitAnyIndex].substr(2);
                this._runBatch(nodeName, nodeInput, waitAnyIndex);
            }
            else if (inputParser.isWaitAnyNode(inp)) {
                const ndName = node.input[waitAnyIndex].substr(2);
                const result = inputParser.extractObject(ndName);
                input[waitAnyIndex] = inputParser.parseValue(nodeInput, result.path);
            }
            else if (inputParser.isNode(inp)) {
                const ndName = node.input[ind].substr(1);
                const result = inputParser.extractObject(ndName);
                input[ind] = inputParser.parseValue(nodeInput, result.path);
            }
        });
        this._nodes.setNode(node.name, { input: input });
        this._createJob(node);
    }

    _taskComplete(task) {
        if (task.error) {
            if (task.batchID) {
                const batchTolerance = this._pipeline.options.batchTolerance;
                const states = this._nodes.getNodeStates(task.nodeName);
                const failed = states.filter(s => s === States.FAILED);
                const percent = failed.length / states.length * 100;

                if (percent >= batchTolerance) {
                    const error = new Error(`${failed.length}/${states.length} (${percent}%) failed tasks, batch tolerance is ${batchTolerance}%, error: ${node.error}`);
                    this._jobComplete(error);
                    return;
                }
            }
            else {
                const error = new Error(`${task.error}`);
                this._jobComplete(error);
                return;
            }
        }
        if (task.batchID) {
            progress.debug({ status: States.ACTIVE });
        }
        else {
            progress.info({ status: States.ACTIVE });
        }
        if (this._nodes.isAllNodesDone()) {
            const result = this._nodes.allNodesResults();
            stateManager.setJobResults(result);
            this._jobComplete();
        }
        else {
            this._runCompleted(task.nodeName);
        }
    }

    async _recover(state) {
        const tasksToRun = [];
        for (let driverTask of state.driverTasks) {
            const jobTask = state.jobTasks.get(driverTask.taskId);
            if (jobTask && jobTask.status !== driverTask.status) {
                driverTask.result = jobTask.result;
                driverTask.status = jobTask.status;
                driverTask.error = jobTask.error;
                log.info(`found ${driverTask.status} task ${driverTask.taskId} after recover`, { component: components.TASK_RUNNER });

                if (driverTask.batchID) {
                    this._nodes.addBatch(new Batch({
                        name: driverTask.nodeName,
                        batchID: driverTask.batchID,
                        algorithm: driverTask.algorithm,
                        input: driverTask.input,
                        state: driverTask.status,
                        result: driverTask.result,
                        error: driverTask.error
                    }));
                }
                else {
                    this._nodes.setNode(driverTask.nodeName, new Node({
                        name: driverTask.nodeName,
                        algorithm: driverTask.algorithmName,
                        input: driverTask.input,
                        state: driverTask.status,
                        result: driverTask.result,
                        error: driverTask.error
                    }));
                }
                await this._setTaskState(driverTask);
                tasksToRun.push(driverTask);
            }
            else {
                await this._setTaskState(driverTask);
            }
        }

        tasksToRun.forEach(t => this._taskComplete(t));
    }

    async _setTaskState(task) {
        this._nodes.updateNodeState(task.nodeName, task.batchID, { state: task.status, error: task.error, result: task.result });
        await stateManager.setTaskState({ taskId: task.taskId, data: task });
        progress.debug({ status: States.ACTIVE });
    }

    _startPipeline(options) {
        const entryNodes = this._nodes.findEntryNodes();
        if (entryNodes.length === 0) {
            throw new Error('unable to find entry nodes');
        }
        entryNodes.forEach(n => this._runNode(n));
    }

    // FIX THIS: DON'T CREATE NEW TASK ON RECOVER
    async _createJob(node) {
        const taskId = this._createTaskID(node.algorithm);
        const task = new Task({
            taskId: taskId,
            nodeName: node.name,
            algorithm: node.algorithm,
            batchID: node.batchID,
            input: node.input
        })
        await this._setTaskState(task);

        const options = {
            taskId: taskId,
            type: node.algorithm,
            data: {
                input: node.input,
                node: node.batchID || node.name,
                jobID: this._job.id
            }
        }
        await producer.createJob(options);
    }

    _createTaskID(type) {
        return [type, uuidv4()].join(':');
    }
}

module.exports = new TaskRunner();
