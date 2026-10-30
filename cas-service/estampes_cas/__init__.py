"""Estampes CAS: a bounded SymPy service. User input is parsed by a closed
parser into a typed AST (estampes.math-ast/1); it never reaches eval/sympify."""

AST_SCHEMA = "estampes.math-ast/1"
RESULT_PROTOCOL = "estampes.cas-result/1"
