"""Flat catalog model for the independent persistent source application."""
from dataclasses import dataclass


@dataclass
class CatalogItem:
    id: str
    sku: str = ""
    name: str = "Unnamed item"
    quantity: int = 0
    unit_price_cents: int = 0
    discontinued: bool = False
    description: str = ""
