const storageManager = require('@hkube/storage-manager');
const validator = require('../validation/api-validator');
const stateManager = require('../state/state-manager');
const { ResourceNotFoundError, ResourceExistsError, } = require('../errors');

class PipelineStore {
    async updatePipeline(options) {
        validator.validateUpdatePipeline(options);
        const pipeline = await stateManager.pipelines.get(options);
        if (!pipeline) {
            throw new ResourceNotFoundError('pipeline', options.name);
        }
        await validator.validateAlgorithmExists(options);
        await storageManager.hkubeStore.put({ type: 'pipeline', name: options.name, data: options });
        await stateManager.pipelines.set(options);
        return options;
    }

    async deletePipeline(options) {
        validator.validatePipelineName(options.name);
        const pipeline = await stateManager.pipelines.get(options);
        if (!pipeline) {
            throw new ResourceNotFoundError('pipeline', options.name);
        }
        return this.deletePipelineFromStore(options);
    }

    async deletePipelineFromStore(options) {
        await storageManager.hkubeStore.delete({ type: 'pipeline', name: options.name });
        await storageManager.hkubeStore.delete({ type: 'readme/pipeline', name: options.name });
        return stateManager.pipelines.delete(options);
    }

    async getPipeline(options) {
        validator.validatePipelineName(options.name);
        const pipeline = await stateManager.pipelines.get(options);
        if (!pipeline) {
            throw new ResourceNotFoundError('pipeline', options.name);
        }
        return pipeline;
    }

    async getPipelines() {
        return stateManager.pipelines.list();
    }

    async insertPipeline(options) {
        validator.validateUpdatePipeline(options);
        await validator.validateAlgorithmExists(options);
        await storageManager.hkubeStore.put({ type: 'pipeline', name: options.name, data: options });

        const pipe = await stateManager.pipelines.get(options);
        if (pipe) {
            throw new ResourceExistsError('pipeline', options.name);
        }
        await stateManager.pipelines.set(options);
        return options;
    }
}

module.exports = new PipelineStore();
