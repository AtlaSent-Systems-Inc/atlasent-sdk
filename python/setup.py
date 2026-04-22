from setuptools import setup, find_packages

setup(
    name="atlasent",
    version="1.0.0",
    description="AtlaSent Python SDK — policy evaluation and governance",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=["httpx>=0.27.0"],
    extras_require={"dev": ["pytest>=8.0", "pytest-asyncio>=0.23", "respx>=0.21"]},
    license="MIT",
)
