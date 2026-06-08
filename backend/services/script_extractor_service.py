"""
Script extractor service — Parse PDF/DOCX/TXT/MD into raw text.

No LLM calls here. This just extracts clean text from uploaded documents.
The "suspected_script_excerpt" and confidence logic is handled in the
frontend via the LLM chat endpoint.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List


class ScriptExtractorService:
    SUPPORTED = {".pdf", ".docx", ".txt", ".md"}

    def extract(self, file_path: Path) -> Dict[str, Any]:
        """Extract text content from a document file.

        Returns dict with keys:
          full_text: str  — all text from the document
          pages: list     — [{index, text}] per page/section
          page_count: int — number of pages/sections
        """
        suffix = file_path.suffix.lower()
        if suffix not in self.SUPPORTED:
            raise ValueError(f"Unsupported file type: {suffix}")
        if suffix == ".pdf":
            return self._extract_pdf(file_path)
        if suffix == ".docx":
            return self._extract_docx(file_path)
        return self._extract_plain(file_path)

    def _extract_pdf(self, path: Path) -> Dict[str, Any]:
        """Extract text from a PDF using pypdf."""
        try:
            from pypdf import PdfReader
        except ImportError:
            # Fallback to pdfplumber if pypdf is not available
            return self._extract_pdf_plumber(path)

        reader = PdfReader(str(path))
        pages: List[Dict[str, Any]] = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            pages.append({"index": i, "text": text})

        full_text = "\n\n".join(p["text"] for p in pages)
        return {
            "full_text": full_text,
            "pages": pages,
            "page_count": len(pages),
        }

    def _extract_pdf_plumber(self, path: Path) -> Dict[str, Any]:
        """Fallback: extract text from a PDF using pdfplumber."""
        import pdfplumber  # type: ignore

        pages: List[Dict[str, Any]] = []
        with pdfplumber.open(str(path)) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                pages.append({"index": i, "text": text})

        full_text = "\n\n".join(p["text"] for p in pages)
        return {
            "full_text": full_text,
            "pages": pages,
            "page_count": len(pages),
        }

    def _extract_docx(self, path: Path) -> Dict[str, Any]:
        """Extract text from a DOCX file using python-docx."""
        from docx import Document  # type: ignore

        doc = Document(str(path))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        text = "\n".join(paragraphs)
        return {
            "full_text": text,
            "pages": [{"index": 0, "text": text}],
            "page_count": 1,
        }

    def _extract_plain(self, path: Path) -> Dict[str, Any]:
        """Extract text from a plain text or markdown file."""
        text = path.read_text(encoding="utf-8", errors="replace")
        return {
            "full_text": text,
            "pages": [{"index": 0, "text": text}],
            "page_count": 1,
        }


script_extractor_service = ScriptExtractorService()
