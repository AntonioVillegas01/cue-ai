
import { useState } from "react";

type Product = {
    id: number;
    name: string;
    price: number;
};

const products: Product[] = [
    { id: 1, name: "Laptop", price: 1200 },
    { id: 2, name: "Keyboard", price: 100 },
    { id: 3, name: "Mouse", price: 50 },
];

export default function ProductList() {
    const [search, setSearch] = useState("");
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

    return (
        <div>
            <h1>Products</h1>
            <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products"
            />
            {products
                .filter((product) =>
                    product.name.toLowerCase().includes(search.toLowerCase())
                )
                .map((product) => (
                    <div key={product.id}>
                        <h3>{product.name}</h3>
                        <p>${product.price}</p>

                        <button onClick={() => setSelectedProduct(product)}>
                            Select
                        </button>
                    </div>
                ))}
            {selectedProduct && (
                <div>
                    <h2>Selected Product</h2>
                    <p>{selectedProduct.name}</p>
                    <p>${selectedProduct.price}</p>
                </div>
            )}
        </div>
    );
}
