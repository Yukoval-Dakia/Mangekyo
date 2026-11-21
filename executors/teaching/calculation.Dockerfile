FROM python:3.12-slim
RUN pip install --no-cache-dir numpy==2.3.5 sympy==1.14.0 matplotlib==3.10.7
ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp/matplotlib OPENBLAS_NUM_THREADS=1
