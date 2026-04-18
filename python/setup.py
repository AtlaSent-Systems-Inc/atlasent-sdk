from setuptools import find_packages, setup

setup(
    name="atlasent",
    version="1.1.0",
    description="AtlaSent Python SDK — policy evaluation and governance",
    packages=find_packages(),
    python_requires=">=3.10",
    install_requires=["httpx>=0.27.0", "pydantic>=2.0"],
    extras_require={
        "dev": [
            "pytest>=8.0",
            "pytest-asyncio>=0.23",
            "pytest-mock>=3.14",
            "respx>=0.21",
            "ruff>=0.4.0",
            "black>=24.0.0",
        ]
    },
    license="MIT",
)
