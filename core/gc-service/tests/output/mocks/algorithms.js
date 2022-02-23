module.exports = [
  {
    name: "output-1",
    algorithmImage: "hkube/algorithm-output",
    cpu: 1.5,
    jobId: "job-1",
    mem: "50Mi",
    type: "Image",
    minHotWorkers: 0,
    kind: "output",
    created: Date.now(),
    modified: Date.now(),
    options: {
      debug: false,
      pending: false,
    },
  },
  {
    name: "output-2",
    algorithmImage: "hkube/algorithm-output",
    jobId: "job-1",
    mem: "50Mi",
    type: "Image",
    minHotWorkers: 0,
    kind: "output",
    created: Date.now() - 300000,
    modified: Date.now() - 650000,
    options: {
      debug: false,
      pending: false,
    },
  },
  {
    name: "output-3",
    algorithmImage: "hkube/algorithm-output",
    cpu: 1.5,
    jobId: "job-notExist",
    mem: "50Mi",
    type: "Image",
    minHotWorkers: 0,
    kind: "output",
    created: Date.now(),
    modified: Date.now(),
    options: {
      debug: false,
      pending: false,
    },
  },
  {
    name: "output-4",
    algorithmImage: "hkube/algorithm-output",
    cpu: 1.5,
    jobId: "job-notExist",
    mem: "50Mi",
    type: "Image",
    minHotWorkers: 0,
    kind: "output",
    created: Date.now() - 300000,
    modified: Date.now() - 650000,
    options: {
      debug: false,
      pending: false,
    },
  }
];