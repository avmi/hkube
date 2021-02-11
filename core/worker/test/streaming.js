const delay = require('delay');
const { expect } = require('chai');
const { uid } = require('@hkube/uid');
const stateAdapter = require('../lib/states/stateAdapter');
const streamHandler = require('../lib/streaming/services/stream-handler');
const streamService = require('../lib/streaming/services/stream-service');
const discovery = require('../lib/streaming/services/service-discovery');
const SlaveAdapter = require('../lib/streaming/adapters/slave-adapter');

const pipeline = {
    name: "stream",
    kind: "stream",
    nodes: [
        {
            nodeName: "A",
            algorithmName: "eval-alg",
            input: [
                "@flowInput.arraySize",
                "@flowInput.bufferSize"
            ],
            stateType: "stateful"
        },
        {
            nodeName: "B",
            algorithmName: "eval-alg",
            input: [
                "@flowInput.arraySize",
                "@flowInput.bufferSize"
            ],
            stateType: "stateful"
        },
        {
            nodeName: "C",
            algorithmName: "eval-alg",
            input: [
                "@flowInput.arraySize",
                "@flowInput.bufferSize"
            ],
            stateType: "stateful"
        },
        {
            nodeName: "D",
            algorithmName: "eval-alg",
            input: [],
            stateType: "stateless"
        },
        {
            nodeName: "E",
            algorithmName: "eval-alg",
            input: [],
            stateType: "stateless"
        }
    ],
    edges: [
        { source: "A", target: "D" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
        { source: "A", target: "E" },
        { source: "B", target: "E" }
    ],
    flowInputMetadata: {
        metadata: {
            "flowInput.arraySize": {
                "type": "number"
            },
            "flowInput.bufferSize": {
                "type": "number"
            }
        },
        storageInfo: {
            "path": "local-hkube/main:streaming:9dy12jfh/main:streaming:9dy12jfh"
        }
    }
}

const streamingDiscovery = {
    host: process.env.POD_IP || '127.0.0.1',
    port: process.env.STREAMING_DISCOVERY_PORT || 9022
};

const addDiscovery = async ({ jobId, nodeName, port }) => {
    stateAdapter._etcd.discovery._client.leaser._lease = null;
    const instanceId = uid({ length: 10 });
    await stateAdapter._etcd.discovery.register({
        data: {
            jobId,
            taskId: uid(),
            nodeName,
            workerStatus: 'working',
            streamingDiscovery: { ...streamingDiscovery, port }
        },
        instanceId
    });
    return instanceId;
};

const deleteDiscovery = async ({ instanceId }) => {
    await stateAdapter._etcd.discovery.delete({ instanceId });
};

const getMasters = () => {
    return streamService._adapters.getMasters();
}

const jobId = uid();

const createJob = (jobId) => {
    const job = {
        jobId,
        kind: 'stream',
        taskId: uid(),
        nodeName: 'C',
        algorithmName: 'my-alg',
        pipelineName: 'my-pipe',
        parents: [],
        childs: ['D'],
    };
    return job;
};

const job = createJob(jobId);

const autoScale = () => {
    const masters = getMasters();
    return masters[0].scale();
}

const checkMetrics = () => {
    return streamService._metrics._checkMetrics() || [];
}

describe('Streaming', () => {
    before(async () => {
        await stateAdapter._db.jobs.create({ pipeline, jobId });
        await streamHandler.start(job);
    });
    beforeEach(() => {
        const masters = getMasters();
        masters.map(m => m.reset());
    })
    describe('scale-up', () => {
        it('should not scale based on no data', async () => {
            const scale = async (data) => {
                streamService.reportStats(data);
            }
            const list = [{
                nodeName: 'D',
            }];
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp).to.be.null;
            expect(scaleDown).to.be.null;
        });
        it('should scale based on queueSize equals 1', async () => {
            const scale = async (data) => {
                streamService.reportStats(data);
            }
            const list = [{
                nodeName: 'D',
                queueSize: 1
            }];
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleUp.scaleTo).to.eql(1);
            expect(scaleDown).to.be.null;
        });
        it('should not scale if currentSize is fixed', async () => {
            const scale = async (data) => {
                streamService.reportStats(data);
                await delay(100);
            }
            const currentSize = async (data) => {
                data[0].currentSize = 5;
                data[0].queueSize += 500
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName: 'D',
                queueSize: 500
            }];

            await scale(list);
            const jobs1 = autoScale();
            const jobs2 = autoScale();
            const jobs3 = autoScale();
            await currentSize(list);
            const jobs4 = autoScale();
            const jobs5 = autoScale();
            expect(jobs1.scaleUp.replicas).to.eql(1);
            expect(jobs1.scaleUp.scaleTo).to.eql(1);
            expect(jobs1.scaleDown).to.be.null;
            expect(jobs2.scaleUp).to.be.null;
            expect(jobs2.scaleDown).to.be.null;
            expect(jobs3.scaleUp).to.be.null;
            expect(jobs3.scaleDown).to.be.null;
            expect(jobs4.scaleUp).to.be.null;
            expect(jobs4.scaleDown).to.be.null;
            expect(jobs5.scaleUp).to.be.null;
            expect(jobs5.scaleDown).to.be.null;
        });
        it('should scale based on queueSize only', async () => {
            const scale = async (data) => {
                streamService.reportStats(data);
            }
            const list = [{
                nodeName: 'D',
                queueSize: 500,
                responses: 0
            }];
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleUp.scaleTo).to.eql(1);
            expect(scaleDown).to.be.null;
        });
        it('should scale based on all params', async () => {
            const scale = async (data) => {
                data[0].currentSize = 0;
                data[0].queueSize += 2;
                data[0].responses += 1;
                streamService.reportStats(data);
                await delay(50);
            }
            const list = [{
                nodeName: 'D',
                queueSize: 2,
                responses: 1,
                durations: [100, 200, 100, 50, 80, 120, 110, 100, 90]
            }];
            await scale(list);
            await scale(list);
            await scale(list);
            await scale(list);
            const scale1 = autoScale();
            const scale2 = autoScale();
            const scale3 = autoScale();

            expect(scale1.scaleUp.replicas).to.eql(4);
            expect(scale1.scaleUp.scaleTo).to.eql(4);
            expect(scale1.scaleDown).to.be.null;
            expect(scale2.scaleUp).to.be.null;
            expect(scale2.scaleDown).to.be.null;
            expect(scale3.scaleUp).to.be.null;
            expect(scale3.scaleDown).to.be.null;
        });
        it('should scale based on queueSize and responses only', async () => {
            const scale = async (data) => {
                streamService.reportStats(data);
            }
            const list = [{
                nodeName: 'D',
                queueSize: 500,
                responses: 100
            }];
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleUp.scaleTo).to.eql(1);
            expect(scaleDown).to.be.null;
        });
        it('should scale up based on high req/res rate', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                data[0].currentSize = 0;
                data[0].queueSize += 100;
                data[0].responses = 100;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName,
                sent: 0,
                queueSize: 0,
                responses: 0
            }];
            await requests(list);
            await requests(list);
            await requests(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleUp.scaleTo).to.eql(1);
            expect(scaleDown).to.be.null;
        });
        it('should scale based on request rate', async () => {
            const scale = async (data) => {
                data[0].sent += 10;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName: 'D',
                sent: 10,
                queueSize: 0
            }];
            await scale(list);
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleUp.scaleTo).to.eql(1);
            expect(scaleDown).to.be.null;
        });
        it('should scale based on high durations', async () => {
            const scale = async (data) => {
                data[0].sent += 100;
                data[0].responses += 30;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName: 'D',
                sent: 0,
                responses: 0,
                durations: [2.34, 3.56, 4.88, 5.12, 2.56, 3.57, 4.59, 1.57, 2.81, 4.23]
            }];
            await scale(list);
            await scale(list);
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(4);
            expect(scaleDown).to.be.null;
        });
        it('should scale based on low durations', async () => {
            const scale = async (data) => {
                data[0].sent += 100;
                data[0].responses += 0;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName: 'D',
                sent: 0,
                responses: 0,
                durations: [0.3, 0.2, 0.8, 0.7, 0.01, 0.1, 0.6, 0.2, 0.1]
            }];
            await scale(list);
            await scale(list);
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleDown).to.be.null;
        });
        it('should scale only up based on req/res rate', async () => {
            const scale = async (data) => {
                data[0].sent += 10;
                data[0].responses += 3;
                streamService.reportStats(data);
                await delay(50);
            }
            const increaseSize = async (data) => {
                data[0].responses += 1;
                data[0].currentSize += 2;
                streamService.reportStats(data);
                await delay(50);
            }
            const list = [{
                nodeName: 'D',
                sent: 10,
                queueSize: 0,
                currentSize: 0,
                responses: 3
            }];
            await scale(list);
            await scale(list);
            const jobs1 = autoScale();
            await increaseSize(list);
            const jobs2 = autoScale();
            await increaseSize(list);
            autoScale();
            const jobs3 = autoScale();
            await scale(list);
            await scale(list);
            const jobs4 = autoScale();
            const jobs5 = autoScale();
            const jobs6 = autoScale();
            expect(jobs1.scaleUp.replicas).to.eql(1);
            expect(jobs2.scaleUp).to.be.null;
            expect(jobs3.scaleUp).to.be.null;
            expect(jobs4.scaleUp).to.be.null;
            expect(jobs5.scaleUp).to.be.null;
            expect(jobs6.scaleUp).to.be.null;
            expect(jobs1.scaleDown).to.be.null;
            expect(jobs2.scaleDown).to.be.null;
            expect(jobs3.scaleDown).to.be.null;
            expect(jobs4.scaleDown).to.be.null;
            expect(jobs5.scaleDown).to.be.null;
            expect(jobs6.scaleDown).to.be.null;
        });
    });
    describe('scale-down', () => {
        it('should scale up and down based on durations', async () => {
            const nodeName = 'D';
            const requestsUp = async (data) => {
                data[0].queueSize += 100;
                streamService.reportStats(data);
                await delay(100);
            }
            const responsesUp = async (data) => {
                data[0].responses += 100;
                data[0].sent = 200;
                data[0].queueSize = 0;
                data[0].currentSize += 1;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName,
                currentSize: 0,
                sent: 0,
                queueSize: 0,
                responses: 0,
                durations: [0.08, 0.09, 0.08, 0.02, 0.01, 0.08, 0.069, 0.05, 0.05]
            }];
            await requestsUp(list);
            await requestsUp(list);
            const jobs1 = autoScale();
            const jobs2 = autoScale();
            await delay(200)
            await responsesUp(list);
            await responsesUp(list);
            const jobs3 = autoScale();
            const jobs4 = autoScale();
            expect(jobs1.scaleUp.replicas).to.eql(1);
            expect(jobs2.scaleUp).to.be.null;
            expect(jobs2.scaleUp).to.be.null;
            expect(jobs3.scaleUp).to.be.null;
            expect(jobs3.scaleDown.replicas).to.eql(1);
            expect(jobs4.scaleUp).to.be.null;
            expect(jobs4.scaleDown).to.be.null;
        });
        it('should scale up and down based on no requests and no responses', async () => {
            const nodeName = 'D';
            const requestsUp = async (data) => {
                data[0].queueSize = 100;
                data[0].responses = 100;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName,
                currentSize: 1,
                sent: 0,
                queueSize: 0,
                responses: 0,
                durations: [0.3, 0.2, 0.8, 0.7, 0.01, 0.1, 0.6, 0.2, 0.1]
            }];
            await requestsUp(list);
            await requestsUp(list);
            await requestsUp(list);
            await requestsUp(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleDown.replicas).to.eql(1);
            expect(scaleUp).to.be.null;
        });
        it('should scale down based on zero ratio', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                data[0].currentSize = 5;
                data[0].queueSize = 100;
                data[0].responses = 100;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName,
                sent: 0,
                queueSize: 0,
                responses: 0
            }];
            await requests(list);
            await requests(list);
            await requests(list);
            await requests(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp).to.be.null;
        });
        it('should not scale down based on responses', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                data[0].currentSize = 5;
                data[0].responses += 100;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName,
                responses: 0
            }];
            await requests(list);
            await requests(list);
            await requests(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp).to.be.null;
            expect(scaleDown).to.be.null;
        });
        it('should not scale down based on currentSize', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                data[0].currentSize = 1;
                data[0].queueSize = 0;
                data[0].responses += 100;
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName,
                sent: 0,
                queueSize: 0,
                responses: 0
            }];
            await requests(list);
            await requests(list);
            await requests(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp).to.be.null;
            expect(scaleDown).to.be.null;
        });
    });
    describe('scale-conflicts', () => {
        it('should only scale up based on master', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                data[0].queueSize += 100;
                data[0].responses += 50;
                streamService.reportStats(data);
                await delay(50);
            }
            const reportSlave = async (slave, data) => {
                data.queueSize += 100;
                data.responses += 50;
                slave.report(data);
                await delay(50);
            }
            const currentSize = 0;
            const list1 = [{ nodeName, queueSize: 150, responses: 30, currentSize }];
            const list2 = { nodeName, queueSize: 450, responses: 150, currentSize };
            const slave = new SlaveAdapter({ jobId, nodeName, source: 'B' });
            await requests(list1);
            await requests(list1);
            await requests(list1);
            await requests(list1);

            await reportSlave(slave, list2);
            await reportSlave(slave, list2);
            await reportSlave(slave, list2);
            await reportSlave(slave, list2);

            const { scaleUp, scaleDown } = autoScale();

            expect(scaleUp.currentSize).to.eql(currentSize);
            expect(scaleUp.replicas).to.eql(1);
            expect(scaleUp.scaleTo).to.eql(scaleUp.replicas + currentSize);
            expect(scaleDown).to.be.null;
        });
        it('should not scale up based on avg master and slaves', async () => {
            const nodeName = 'D';
            const reportSlave = async (slave, data) => {
                data.queueSize += 100;
                data.responses += 50;
                slave.report(data);
                await delay(50)
            }
            const currentSize = 0;
            const list1 = { nodeName, queueSize: 300, responses: 40, currentSize };
            const list2 = { nodeName, queueSize: 300, responses: 60, currentSize };
            const list3 = { nodeName, queueSize: 300, responses: 80, currentSize };
            const list4 = { nodeName, queueSize: 300, responses: 100, currentSize };
            const slave1 = new SlaveAdapter({ jobId, nodeName, source: 'A' });
            const slave2 = new SlaveAdapter({ jobId, nodeName, source: 'B' });
            const slave3 = new SlaveAdapter({ jobId, nodeName, source: 'C' });
            const slave4 = new SlaveAdapter({ jobId, nodeName, source: 'D' });
            await reportSlave(slave1, list1);
            await reportSlave(slave1, list1);
            await reportSlave(slave1, list1);
            await reportSlave(slave1, list1);

            await reportSlave(slave2, list2);
            await reportSlave(slave2, list2);
            await reportSlave(slave2, list2);
            await reportSlave(slave2, list2);

            slave3.report(list3);
            slave3.report(list3);
            slave3.report(list3);
            slave3.report(list3);

            slave4.report(list4);
            slave4.report(list4);
            slave4.report(list4);
            slave4.report(list4);
            await delay(200);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp.currentSize).to.eql(currentSize);
            expect(scaleUp.replicas).to.gte(1);
            expect(scaleUp.scaleTo).to.gte(scaleUp.replicas + currentSize);
            expect(scaleDown).to.be.null;
        });
    });
    describe('no-scale', () => {
        it('should not scale when no relevant data', async () => {
            const scale = async (data) => {
                streamService.reportStats(data);
                await delay(100);
            }
            const list = [{
                nodeName: 'D'
            }];
            await scale(list);
            await scale(list);
            await scale(list);
            const { scaleUp, scaleDown } = autoScale();
            expect(scaleUp).to.be.null;
            expect(scaleDown).to.be.null;
        });
        it('should not over the maxSizeWindow', async () => {
            const nodeName = 'D';
            const data = [{
                nodeName,
                queueSize: 10,
                durations: [2.34, 3.56, 4.88, 5.12, 2.56, 3.57, 4.59, 1.57, 2.81, 4.23]
            }];
            streamService.reportStats(data);
            streamService.reportStats(data);
            streamService.reportStats(data);
            streamService.reportStats(data);
            streamService.reportStats(data);
            streamService.reportStats(data);
            const masters = getMasters();
            const statsData = masters[0]._autoScaler._statistics._data;
            const key = Object.keys(statsData)[0];
            const stats = statsData[key];
            const { requests, responses, durations } = stats;
            const maxSizeWindow = testParams.config.streaming.autoScaler.maxSizeWindow;
            expect(requests.items).to.have.lengthOf(maxSizeWindow);
            expect(responses.items).to.have.lengthOf(maxSizeWindow);
            expect(durations.items).to.have.lengthOf(maxSizeWindow);
        });
    });
    describe('metrics', () => {
        it('should scale and update metrics', async () => {
            const nodeName = 'D';
            const requests = 30;
            const responses = 10;
            const dropped = 5;
            const scale = async (stats) => {
                stats[0].queueSize += requests
                stats[0].responses += responses;
                stats[0].dropped += dropped;
                streamService.reportStats(stats);
                autoScale();
                await delay(20);
            }
            const stat = {
                nodeName,
                queueSize: 0,
                responses: 0,
                dropped: 0
            }
            const stats = [stat];

            await scale(stats);
            const metrics1 = checkMetrics()[0];
            await scale(stats);
            const metrics2 = checkMetrics()[0];
            await scale(stats);
            const metrics3 = checkMetrics()[0];
            expect(metrics1.source).to.eql('C');
            expect(metrics1.target).to.eql('D');
            expect(metrics1.requests).to.eql(requests);
            expect(metrics1.responses).to.eql(responses);
            expect(metrics1.dropped).to.eql(dropped);

            expect(metrics2.source).to.eql('C');
            expect(metrics2.target).to.eql('D');
            expect(metrics2.requests).to.eql(requests);
            expect(metrics2.responses).to.eql(responses);
            expect(metrics2.dropped).to.eql(dropped);

            expect(metrics3.source).to.eql('C');
            expect(metrics3.target).to.eql('D');
            expect(metrics3.requests).to.eql(requests);
            expect(metrics3.responses).to.eql(responses);
            expect(metrics3.dropped).to.eql(dropped);
        });
    });
    describe('master-slaves', () => {
        it('should get slaves', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                streamService.reportStats(data);
            }
            const currentSize = 2;
            const list = [{ nodeName, queueSize: 150, responses: 30, currentSize }];
            const list1 = { nodeName, queueSize: 300, responses: 80, currentSize };
            const list2 = { nodeName, queueSize: 150, responses: 150, currentSize };
            const slave1 = new SlaveAdapter({ jobId, nodeName, source: 'A' });
            const slave2 = new SlaveAdapter({ jobId, nodeName, source: 'B' });
            await requests(list);
            slave1.report(list1);
            slave2.report(list2);
            await delay(500);
            const masters = getMasters();
            const slaves = masters[0].slaves();
            expect(slaves.sort()).to.deep.equal([slave1.source, slave2.source])
        });
        it('should scale up based on avg master and slaves', async () => {
            const nodeName = 'D';
            const requests = async (data) => {
                data[0].queueSize += 100;
                data[0].responses += 50;
                streamService.reportStats(data);
                await delay(20);
            }
            const reportSlave = async (slave, data) => {
                data.queueSize += 100;
                data.responses += 50;
                slave.report(data);
                await delay(20);
            }
            const currentSize = 0;
            const list = [{ nodeName, queueSize: 150, responses: 30, currentSize }];
            const list1 = { nodeName, queueSize: 300, responses: 80, currentSize };
            const list2 = { nodeName, queueSize: 450, responses: 140, currentSize };
            const slave1 = new SlaveAdapter({ jobId, nodeName, source: 'A' });
            const slave2 = new SlaveAdapter({ jobId, nodeName, source: 'A' });
            const slave3 = new SlaveAdapter({ jobId, nodeName, source: 'A' });
            const slave4 = new SlaveAdapter({ jobId, nodeName, source: 'B' });
            await requests(list);
            await requests(list);
            await requests(list);
            await requests(list);
            await reportSlave(slave1, list1);
            await reportSlave(slave1, list1);
            await reportSlave(slave1, list1);
            await reportSlave(slave1, list1);

            await reportSlave(slave2, list1);
            await reportSlave(slave2, list1);
            await reportSlave(slave2, list1);
            await reportSlave(slave2, list1);

            await reportSlave(slave3, list1);
            await reportSlave(slave3, list1);
            await reportSlave(slave3, list1);
            await reportSlave(slave3, list1);

            await reportSlave(slave4, list2);
            await reportSlave(slave4, list2);
            await reportSlave(slave4, list2);
            await reportSlave(slave4, list2);
            await delay(200);

            const { scaleUp, scaleDown } = autoScale();
            const metrics = checkMetrics();

            expect(metrics.map(t => t.source).sort()).to.eql(['A', 'B', 'C']);
            expect(metrics).to.have.lengthOf(3);
            expect(scaleUp.currentSize).to.eql(currentSize);
            expect(scaleUp.replicas).to.gte(2);
            expect(scaleDown).to.be.null;
        });
        it('should start and finish correctly', async () => {
            expect(streamService._jobData).to.be.not.null;
            expect(streamService._election).to.be.not.null;
            expect(streamService._adapters).to.be.not.null;
            expect(streamService._metrics).to.be.not.null;
            expect(streamService._scalerService).to.be.not.null;
            expect(streamService._active).to.eql(true);
            await streamService.finish(job);
            expect(streamService._jobData).to.be.null;
            expect(streamService._election).to.be.null;
            expect(streamService._adapters).to.be.null;
            expect(streamService._metrics).to.be.null;
            expect(streamService._scalerService).to.be.null;
            await streamService.start(job);
        });
    });
    describe('discovery', () => {
        beforeEach(() => {
            discovery._discoveryMap = Object.create(null);
        });
        it('should add discovery and get right changes', async () => {
            const jobId = uid();
            const nodeName = uid();
            const changes1 = await discovery._checkDiscovery({ jobId, taskId: uid() });
            await addDiscovery({ jobId, nodeName, port: 5001 });
            const changes2 = await discovery._checkDiscovery({ jobId, taskId: uid() });
            expect(changes1).to.have.lengthOf(0);
            expect(changes2).to.have.lengthOf(1);
            expect(changes2[0].type).to.eql('Add');
            expect(changes2[0].nodeName).to.eql(nodeName);
        });
        it('should add discovery multiple times and get right changes', async () => {
            const jobId = uid();
            const nodeName1 = uid();
            const nodeName2 = uid();
            await addDiscovery({ jobId, nodeName: nodeName1, port: 5001 });
            await addDiscovery({ jobId, nodeName: nodeName2, port: 5002 });
            const changes1 = await discovery._checkDiscovery({ jobId, taskId: uid() });
            await addDiscovery({ jobId, nodeName: nodeName1, port: 5003 });
            await addDiscovery({ jobId, nodeName: nodeName2, port: 5004 });
            const changes2 = await discovery._checkDiscovery({ jobId, taskId: uid() });
            expect(changes1).to.have.lengthOf(2);
            expect(changes2).to.have.lengthOf(2);
            expect(changes1[0].type).to.eql('Add');
            expect(changes1[1].type).to.eql('Add');
            expect(changes1[0].nodeName).to.eql(nodeName2);
            expect(changes1[1].nodeName).to.eql(nodeName1);
            expect(changes2[0].type).to.eql('Add');
            expect(changes2[1].type).to.eql('Add');
            expect(changes2[0].nodeName).to.eql(nodeName2);
            expect(changes2[1].nodeName).to.eql(nodeName1);
        });
        it('should add and delete discovery and get right changes', async () => {
            const jobId = uid();
            const nodeName = uid();
            await addDiscovery({ jobId, nodeName, port: 5001 });
            const instanceId1 = await addDiscovery({ jobId, nodeName, port: 5002 });
            const instanceId2 = await addDiscovery({ jobId, nodeName, port: 5003 });
            const changes1 = await discovery._checkDiscovery({ jobId, taskId: uid() });
            await deleteDiscovery({ instanceId: instanceId1 });
            await deleteDiscovery({ instanceId: instanceId2 });
            const changes2 = await discovery._checkDiscovery({ jobId, taskId: uid() });
            expect(changes1).to.have.lengthOf(3);
            expect(changes2).to.have.lengthOf(2);
            expect(changes2[0].type).to.eql('Del');
            expect(changes2[1].type).to.eql('Del');
        });
        it('should add discovery and get right changes', async () => {
            const jobId = uid();
            const nodeName1 = uid();
            const nodeName2 = uid();
            await addDiscovery({ jobId, nodeName: nodeName1, port: 5001 });
            await addDiscovery({ jobId, nodeName: nodeName1, port: 5002 });
            await addDiscovery({ jobId, nodeName: nodeName2, port: 5003 });
            await addDiscovery({ jobId, nodeName: nodeName2, port: 5004 });
            await discovery._checkDiscovery({ jobId, taskId: uid() });
            const count1 = discovery.countInstances(nodeName1);
            const count2 = discovery.countInstances(nodeName2);
            expect(count1).to.eql(2);
            expect(count2).to.eql(2);
        });
    });
});
