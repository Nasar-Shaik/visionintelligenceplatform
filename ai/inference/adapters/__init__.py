"""Model-backend adapters. The dependency-free `FakeModelAdapter` is imported eagerly; the heavy
`OnnxModelAdapter` + `MlflowModelResolver` are imported LAZILY by the bootstrap only for the `onnx`
backend, so the runtime and its unit tests never load onnxruntime/mlflow/numpy/pillow.
"""
