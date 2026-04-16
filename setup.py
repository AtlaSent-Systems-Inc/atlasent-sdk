"""Package setup for atlasent."""

import re

from setuptools import find_packages, setup

with open("README.md", encoding="utf-8") as f:
    long_description = f.read()

with open("atlasent/_version.py", encoding="utf-8") as f:
    version = re.search(r'__version__\s*=\s*"(.+?)"', f.read()).group(1)

setup(
    name="atlasent",
    version=version,
    description="Python SDK for the AtlaSent authorization API",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="AtlaSent Systems Inc.",
    author_email="sdk@atlasent.io",
    url="https://github.com/AtlaSent-Systems-Inc/atlasent-sdk-python",
    packages=find_packages(exclude=["tests", "tests.*", "examples"]),
    python_requires=">=3.10",
    install_requires=[
        "httpx>=0.24.0",
        "pydantic>=2.0.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0",
            "pytest-mock>=3.10",
            "pytest-asyncio>=0.21.0",
            "black>=23.0",
            "ruff>=0.1.0",
        ],
    },
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Security",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Typing :: Typed",
    ],
    keywords="atlasent authorization ai agents gxp compliance",
)
